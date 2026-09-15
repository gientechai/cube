/**
 * Split a leading WITH / WITH RECURSIVE clause from the main SELECT.
 * Used to hoist nested CTEs into a flat outer WITH list (GBase, Oracle, etc.).
 *
 * Heuristic scanner: tracks paren depth and single-quoted strings only
 * (same fidelity as the former OracleQuery helper).
 *
 * @param {string} sql
 * @returns {{ recursive: boolean, cteDefsSql: string, mainSql: string, withClause: string } | null}
 */
export function splitLeadingWithClause(sql) {
  const trimmed = sql.trim();
  const withMatch = trimmed.match(/^WITH\s+(RECURSIVE\s+)?/i);
  if (!withMatch) {
    return null;
  }

  const recursive = Boolean(withMatch[1]);
  let depth = 0;
  let inSingleQuote = false;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];

    if (inSingleQuote) {
      if (c === '\'' && trimmed[i + 1] === '\'') {
        i += 1;
      } else if (c === '\'') {
        inSingleQuote = false;
      }
      continue;
    }

    if (c === '\'') {
      inSingleQuote = true;
      continue;
    }

    if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
    } else if (depth === 0 && /^SELECT\b/i.test(trimmed.slice(i))) {
      const withClause = trimmed.slice(0, i).trim();
      const mainSql = trimmed.slice(i).trim();
      const cteDefsSql = withClause
        .replace(/^WITH\s+(RECURSIVE\s+)?/i, '')
        .trim()
        .replace(/,\s*$/, '');

      if (!cteDefsSql) {
        return null;
      }

      return {
        recursive,
        cteDefsSql,
        mainSql,
        withClause,
      };
    }
  }

  return null;
}

/**
 * Merge leading WITH clauses from child SQL fragments into one flat WITH list.
 *
 * @param {string[]} cteParts already-flat `alias AS (...)` fragments (no WITH keyword)
 * @param {{ recursive?: boolean }} [options]
 * @returns {string} `WITH [RECURSIVE]\n...` or empty string if no parts
 */
export function formatWithClause(cteParts, options = {}) {
  const parts = (cteParts || []).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) {
    return '';
  }
  const keyword = options.recursive ? 'WITH RECURSIVE' : 'WITH';
  return `${keyword}\n${parts.join(',\n')}`;
}
