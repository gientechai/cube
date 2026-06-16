export type KingbaseOraclePlaceholderNormalization = {
  sql: string;
  values: unknown[];
};

export function normalizeKingbaseOraclePlaceholders(
  sql: string,
  values: unknown[] = []
): KingbaseOraclePlaceholderNormalization {
  let nextIndex = 0;
  const named = new Map<string, number>();
  let output = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
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

    if (ch === "'") {
      output += ch;
      if (!inDoubleQuote && inSingleQuote && next === "'") {
        output += next;
        i++;
      } else if (!inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }

    if (!inSingleQuote && ch === '"') {
      output += ch;
      if (inDoubleQuote && next === '"') {
        output += next;
        i++;
      } else {
        inDoubleQuote = !inDoubleQuote;
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && ch === '-' && next === '-') {
      output += ch + next;
      i++;
      inLineComment = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && ch === '/' && next === '*') {
      output += ch + next;
      i++;
      inBlockComment = true;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && ch === ':' && next === '"') {
      const end = sql.indexOf('"', i + 2);
      if (end !== -1) {
        const token = sql.slice(i + 2, end);
        if (token === '?') {
          output += `$${++nextIndex}`;
        } else {
          if (!named.has(token)) {
            named.set(token, ++nextIndex);
          }
          output += `$${named.get(token)}`;
        }
        i = end;
        continue;
      }
    }

    if (!inSingleQuote && !inDoubleQuote && ch === '?' && nextIndex < values.length) {
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
