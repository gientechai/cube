import { normalizeKingbaseMysqlPlaceholders } from '../src/KingbaseMysqlPlaceholder';

describe('Kingbase MySQL Placeholder Normalization', () => {
  test('normalizes positional placeholders in SQL text order', () => {
    expect(normalizeKingbaseMysqlPlaceholders(
      'select * from orders where status = ? and amount > ?',
      ['paid', 100]
    )).toEqual({
      sql: 'select * from orders where status = $1 and amount > $2',
      values: ['paid', 100],
    });
  });

  test('preserves parameter order through IN lists and timestamp casts', () => {
    expect(normalizeKingbaseMysqlPlaceholders(
      'select * from events where id in (?, ?, ?) and ts >= CAST(? AS DATETIME)',
      [10, 20, 30, '2026-06-16T00:00:00.000Z']
    ).sql).toEqual(
      'select * from events where id in ($1, $2, $3) and ts >= CAST($4 AS DATETIME)'
    );
  });

  test('does not normalize bare question marks without matching parameter values', () => {
    expect(normalizeKingbaseMysqlPlaceholders(
      'select ? as maybe_operator',
      []
    )).toEqual({
      sql: 'select ? as maybe_operator',
      values: [],
    });
  });

  test('skips quoted strings, quoted identifiers, backtick identifiers, and comments', () => {
    expect(normalizeKingbaseMysqlPlaceholders(
      'select \'?\' as literal, ? as value, "identifier ?" as ident, `backtick ?` as b -- keep ?\nfrom orders /* keep ? */ where code = ?',
      ['cube', 'ok']
    )).toEqual({
      sql: 'select \'?\' as literal, $1 as value, "identifier ?" as ident, `backtick ?` as b -- keep ?\nfrom orders /* keep ? */ where code = $2',
      values: ['cube', 'ok'],
    });
  });
});
