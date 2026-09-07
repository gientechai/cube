import { CubejsHandlerError } from './cubejs-handler-error';

/**
 * 只读 SQL 直查端点（POST /cubejs-api/v1/raw-sql）的语句防护。
 *
 * 注意：该端点绕过语义层（数据模型、行列权限 access_policy、result_mask 脱敏、
 * queryRewrite 注入），直接在目标数据源上执行调用方 SQL，因此必须在入口处
 * 做只读校验，禁止任何可能改写数据 / 结构 / 会话状态的语句。
 */

/** 允许执行的首关键词（语句必须以其中之一开头） */
const READ_ONLY_FIRST_KEYWORDS = ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];

/**
 * 全文禁止出现的关键词（不限位置）：
 * - 写数据：INSERT / UPDATE / DELETE / MERGE / REPLACE / COPY / LOAD / IMPORT / EXPORT
 * - 写结构：CREATE / DROP / TRUNCATE / ALTER / RENAME / COMMENT / ATTACH / DETACH
 * - 权限：GRANT / REVOKE
 * - 会话/事务状态（连接池共享会话，禁止污染）：SET / RESET / USE / LOCK / UNLOCK /
 *   BEGIN / START / COMMIT / ROLLBACK / SAVEPOINT / PREPARE / DEALLOCATE
 * - 维护/管理：VACUUM / ANALYZE / KILL / SHUTDOWN / CALL / DO / EXEC / EXECUTE
 */
const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'COPY', 'LOAD', 'IMPORT', 'EXPORT',
  'CREATE', 'DROP', 'TRUNCATE', 'ALTER', 'RENAME', 'COMMENT', 'ATTACH', 'DETACH',
  'GRANT', 'REVOKE',
  'SET', 'RESET', 'USE', 'LOCK', 'UNLOCK',
  'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'PREPARE', 'DEALLOCATE',
  'VACUUM', 'ANALYZE', 'KILL', 'SHUTDOWN', 'CALL', 'DO', 'EXEC', 'EXECUTE',
];

/**
 * 剥离 SQL 中的注释与字符串/标识符字面量：
 * - 行注释（-- ...）、块注释（/* ... *\/）
 * - 单引号字符串（含 '' 与 \' 转义）、双引号（含 "" 转义）、MySQL 反引号标识符
 * - PostgreSQL dollar-quoted 字符串（$$...$$ / $tag$...$tag$）
 *
 * 字面量统一替换为空串 ''，注释替换为空格。返回结果仅用于关键词扫描与
 * 多语句检测（识别引号外的分号），不会被发送到数据库执行。
 */
export function stripSqlLiteralsAndComments(sql: string): string {
  let result = '';
  let i = 0;
  const n = sql.length;

  const readQuoted = (quote: string, allowBackslashEscape: boolean) => {
    // 进入引号时 i 已指向首引号
    result += "''";
    i++;
    while (i < n) {
      if (allowBackslashEscape && sql[i] === '\\') {
        i += 2;
        continue;
      }
      if (sql[i] === quote) {
        if (sql[i + 1] === quote) {
          // 转义的连续引号（'' / "" / ``）
          i += 2;
          continue;
        }
        i++;
        break;
      }
      i++;
    }
  };

  while (i < n) {
    const ch = sql[i];
    const next = i + 1 < n ? sql[i + 1] : '';

    // 行注释 -- ...
    if (ch === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') {
        i++;
      }
      result += ' ';
      continue;
    }

    // 块注释 /* ... */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i++;
      }
      i = Math.min(i + 2, n);
      result += ' ';
      continue;
    }

    if (ch === '\'') {
      readQuoted('\'', true);
      continue;
    }

    if (ch === '"') {
      readQuoted('"', true);
      continue;
    }

    if (ch === '`') {
      readQuoted('`', false);
      continue;
    }

    // PostgreSQL dollar-quoted 字符串：$$...$$ 或 $tag$...$tag$
    if (ch === '$') {
      const matched = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (matched) {
        const tag = matched[0];
        const end = sql.indexOf(tag, i + tag.length);
        result += "''";
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * 校验 SQL 为单条只读语句，否则抛出 CubejsHandlerError(400)。
 * 规则：
 * 1. 首关键词必须命中只读白名单（SELECT / WITH / SHOW / DESCRIBE / DESC / EXPLAIN）；
 * 2. 剥离注释与字面量后的全文不得出现禁止关键词（防 `WITH x AS (DELETE ...)` 之类 CTE 写入）；
 * 3. 不得为多语句（引号外分号后仍有内容）。
 */
export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new CubejsHandlerError(400, 'Bad Request', 'SQL statement is required');
  }

  const stripped = stripSqlLiteralsAndComments(sql);
  const trimmed = stripped.trim();
  if (!trimmed) {
    throw new CubejsHandlerError(400, 'Bad Request', 'SQL statement is required');
  }

  // 1. 首关键词白名单
  const firstKeyword = ((/^[A-Za-z]+/.exec(trimmed) || [])[0] || '').toUpperCase();
  if (!READ_ONLY_FIRST_KEYWORDS.includes(firstKeyword)) {
    throw new CubejsHandlerError(
      400,
      'Bad Request',
      `Only read-only SQL statements are allowed (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN), got: ${firstKeyword || '<empty>'}`
    );
  }

  // 2. 禁止关键词全文扫描
  const keywordRegex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
  let matched: RegExpExecArray | null;
  while ((matched = keywordRegex.exec(stripped)) !== null) {
    const token = matched[0].toUpperCase();
    if (FORBIDDEN_KEYWORDS.includes(token)) {
      throw new CubejsHandlerError(
        400,
        'Bad Request',
        `Read-only endpoint rejected the forbidden keyword: ${token}`
      );
    }
  }

  // 3. 多语句检测：字面量与注释已剥离，分号后仍有内容即视为多语句
  const semicolonIndex = stripped.indexOf(';');
  if (semicolonIndex !== -1 && stripped.slice(semicolonIndex + 1).trim() !== '') {
    throw new CubejsHandlerError(400, 'Bad Request', 'Multiple SQL statements are not allowed');
  }
}
