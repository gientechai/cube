import { formatWithClause, splitLeadingWithClause } from '../../src/adapter/helpers/sqlWithClause';

describe('sqlWithClause', () => {
  it('splitLeadingWithClause extracts CTE defs and main SELECT', () => {
    const sql = 'WITH base_data AS (\n  SELECT 1 AS x\n), matched AS (\n  SELECT x FROM base_data\n)\nSELECT x FROM matched';
    const split = splitLeadingWithClause(sql);
    expect(split).not.toBeNull();
    expect(split!.recursive).toBe(false);
    expect(split!.cteDefsSql).toMatch(/^base_data AS \(/i);
    expect(split!.cteDefsSql).toMatch(/matched AS \(/i);
    expect(split!.mainSql).toMatch(/^SELECT x FROM matched$/i);
  });

  it('splitLeadingWithClause detects WITH RECURSIVE', () => {
    const sql = 'WITH RECURSIVE t AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT * FROM t';
    const split = splitLeadingWithClause(sql);
    expect(split).not.toBeNull();
    expect(split!.recursive).toBe(true);
    expect(split!.mainSql).toMatch(/^SELECT \* FROM t$/i);
  });

  it('splitLeadingWithClause returns null without leading WITH', () => {
    expect(splitLeadingWithClause('SELECT 1')).toBeNull();
  });

  it('formatWithClause joins parts and optional RECURSIVE', () => {
    expect(formatWithClause(['a AS (SELECT 1)', 'b AS (SELECT 2)'])).toBe(
      'WITH\na AS (SELECT 1),\nb AS (SELECT 2)',
    );
    expect(formatWithClause(['t AS (SELECT 1)'], { recursive: true })).toBe(
      'WITH RECURSIVE\nt AS (SELECT 1)',
    );
    expect(formatWithClause([])).toBe('');
  });
});
