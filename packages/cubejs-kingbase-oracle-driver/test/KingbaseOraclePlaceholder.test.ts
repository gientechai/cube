import { normalizeKingbaseOraclePlaceholders } from '../src/KingbaseOraclePlaceholder';

describe('Kingbase Oracle Placeholder Normalization', () => {
  test('normalizes positional placeholders in SQL text order', () => {
    expect(normalizeKingbaseOraclePlaceholders(
      'select * from orders where status = :"?" and amount > :"?"',
      ['paid', 100]
    )).toEqual({
      sql: 'select * from orders where status = $1 and amount > $2',
      values: ['paid', 100],
    });
  });

  test('reuses placeholder index for repeated named placeholders', () => {
    expect(normalizeKingbaseOraclePlaceholders(
      'select * from orders where created_at >= :"from" and updated_at >= :"from"',
      ['2026-01-01']
    )).toEqual({
      sql: 'select * from orders where created_at >= $1 and updated_at >= $1',
      values: ['2026-01-01'],
    });
  });

  test('normalizes IN lists and timestamp casts', () => {
    expect(normalizeKingbaseOraclePlaceholders(
      'select * from events where id in (:"?", :"?", :"?") and ts >= TO_TIMESTAMP_TZ(:"?", \'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"\')',
      [10, 20, 30, '2026-06-16T00:00:00.000Z']
    ).sql).toEqual(
      'select * from events where id in ($1, $2, $3) and ts >= TO_TIMESTAMP_TZ($4, \'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"\')'
    );
  });

  test('normalizes bare positional placeholders in SQL text order', () => {
    expect(normalizeKingbaseOraclePlaceholders(
      'select * from events where status = ? and amount in (?, ?)',
      ['paid', 10, 20]
    )).toEqual({
      sql: 'select * from events where status = $1 and amount in ($2, $3)',
      values: ['paid', 10, 20],
    });
  });

  test('does not normalize bare question marks without matching parameter values', () => {
    expect(normalizeKingbaseOraclePlaceholders(
      'select ? as maybe_operator from dual',
      []
    )).toEqual({
      sql: 'select ? as maybe_operator from dual',
      values: [],
    });
  });

  test('skips quoted strings, quoted identifiers, and comments', () => {
    expect(normalizeKingbaseOraclePlaceholders(
      'select \':"?\" ?\' as literal, :"?" as value, ? as bare_value, "literal :""?"" ?" as ident -- keep :"?" ?\nfrom dual /* keep :"?" ? */',
      ['value']
    ).sql).toEqual(
      'select \':"?\" ?\' as literal, $1 as value, ? as bare_value, "literal :""?"" ?" as ident -- keep :"?" ?\nfrom dual /* keep :"?" ? */'
    );
  });

  test('skips quoted and commented bare question marks while normalizing real parameters', () => {
    expect(normalizeKingbaseOraclePlaceholders(
      'select \'?\' as literal, ? as value, "identifier ?" as ident -- keep ?\nfrom dual /* keep ? */ where code = ?',
      ['cube', 'ok']
    )).toEqual({
      sql: 'select \'?\' as literal, $1 as value, "identifier ?" as ident -- keep ?\nfrom dual /* keep ? */ where code = $2',
      values: ['cube', 'ok'],
    });
  });
});
