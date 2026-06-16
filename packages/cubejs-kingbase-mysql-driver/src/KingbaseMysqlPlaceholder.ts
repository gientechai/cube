/* eslint-disable no-continue */

export type KingbaseMysqlPlaceholderNormalization = {
  sql: string;
  values: unknown[];
};

export function normalizeKingbaseMysqlPlaceholders(
  sql: string,
  values: unknown[] = []
): KingbaseMysqlPlaceholderNormalization {
  let nextIndex = 0;
  let output = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktickQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      output += ch;
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      output += ch;
      if (ch === '*' && next === '/') {
        output += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (ch === '\'' && !inDoubleQuote && !inBacktickQuote) {
      output += ch;
      if (inSingleQuote && next === '\'') {
        output += next;
        i++;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }

    if (ch === '"' && !inSingleQuote && !inBacktickQuote) {
      output += ch;
      if (inDoubleQuote && next === '"') {
        output += next;
        i++;
      } else {
        inDoubleQuote = !inDoubleQuote;
      }
      continue;
    }

    if (ch === '`' && !inSingleQuote && !inDoubleQuote) {
      output += ch;
      if (inBacktickQuote && next === '`') {
        output += next;
        i++;
      } else {
        inBacktickQuote = !inBacktickQuote;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktickQuote && ch === '-' && next === '-') {
      output += ch + next;
      i++;
      inLineComment = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktickQuote && ch === '/' && next === '*') {
      output += ch + next;
      i++;
      inBlockComment = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktickQuote && ch === '?' && nextIndex < values.length) {
      output += `$${++nextIndex}`;
      continue;
    }

    output += ch;
  }

  return {
    sql: output,
    values,
  };
}
