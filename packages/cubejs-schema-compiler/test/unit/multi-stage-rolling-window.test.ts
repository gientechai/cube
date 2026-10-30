/**
 * Unit tests for two multi-branch/multi-stage fixes (BaseQuery.js):
 *
 * 1. branchJoin(): regularMeasuresSubQuery builds its FROM from the cubes actually
 *    referenced by the branch (measures/dimensions/filters), not the whole query join
 *    tree — prevents a belongsTo-declared lookup table (physically one row per
 *    org+year+indicator) from fanning out the base cube's sum.
 *
 * 2. to_date rollingWindow in multi-stage chains:
 *    - expandTimeDimensionsToRollingStart(): the leaf stage of a to_date rolling member
 *      fetches from the rolling granularity period start (e.g. year start), not the
 *      query window start;
 *    - wrapToDateRollingStages(): the member's stage output is a running sum
 *      (PARTITION BY coexisting dimensions + rolling granularity bucket, ORDER BY query
 *      time grain), so the join axis stays on the query time grain.
 *
 *    time_shift composes with the expansion: a to_date rolling member shifted 1 year
 *    back reads [last year start, last year same period].
 */

import { PostgresQuery } from '../../src';
import { prepareYamlCompiler } from './PrepareCompiler';

/**
 * Inline bound params ($1, $2, …) into the SQL text so date-range assertions can match
 * literal values (bounds are rendered as params, not inline literals).
 */
const inlineParams = ([sql, params]: [string, any[]]): string =>
  params.reduce(
    (acc, p, i) => acc.replace(new RegExp(`\\$${i + 1}(?![0-9])`, 'g'), `'${p}'`),
    sql
  );

describe('Multi-stage to_date rolling window', () => {
  describe('to_date/year member with narrow month window', () => {
    const compilers = prepareYamlCompiler(`
cubes:
  - name: ledger
    sql: "SELECT 1 AS id, 10 AS amt, '2026-01-31'::timestamp AS data_dt
         UNION ALL SELECT 2, 20, '2026-02-28'
         UNION ALL SELECT 3, 30, '2026-03-31'
         UNION ALL SELECT 4, 40, '2025-03-31'"

    dimensions:
      - name: data_dt
        sql: data_dt
        type: time

    measures:
      - name: ptd
        type: sum
        sql: amt
      - name: ytd
        type: sum
        sql: "{ptd}"
        multi_stage: true
        rolling_window:
          type: to_date
          granularity: year
`);

    it('expands the rolling leaf window to year start and wraps the stage in a running sum', async () => {
      await compilers.compiler.compile();

      const query = new PostgresQuery(compilers, {
        measures: ['ledger.ptd', 'ledger.ytd'],
        timeDimensions: [{
          dimension: 'ledger.data_dt',
          granularity: 'month',
          dateRange: ['2026-03-01', '2026-03-31'],
        }],
        timezone: 'UTC',
      });
      const sql = inlineParams(query.buildSqlAndParams());

      expect(sql).toMatch(/^\s*WITH\s+/i);
      // 1a: the ytd chain leaf spans from year start (the plain ptd chain stays on the
      // narrow month window — two separate leaf CTEs after the equality-based dedupe)
      expect(sql).toMatch(/'2026-01-01T00:00:00\.000Z'::timestamptz/);
      // 1b: the ytd stage output is a running sum partitioned by the year bucket of the
      // query-grain time column, keeping the month join axis
      expect(sql).toContain(
        `sum("ledger__ytd") OVER (PARTITION BY date_trunc('year', "ledger__data_dt_month") `
        + `ORDER BY "ledger__data_dt_month") "ledger__ytd"`
      );
    });

    it('keeps coexisting dimensions inside the running-sum partition', async () => {
      await compilers.compiler.compile();

      const compilersWithDim = prepareYamlCompiler(`
cubes:
  - name: ledger2
    sql: "SELECT 1 AS id, 10 AS amt, 'o1' AS org_id, '2026-01-31'::timestamp AS data_dt
         UNION ALL SELECT 2, 20, 'o2', '2026-02-28'"

    dimensions:
      - name: data_dt
        sql: data_dt
        type: time
      - name: org_id
        sql: org_id
        type: string

    measures:
      - name: ptd
        type: sum
        sql: amt
      - name: ytd
        type: sum
        sql: "{ptd}"
        multi_stage: true
        rolling_window:
          type: to_date
          granularity: year
`);
      await compilersWithDim.compiler.compile();

      const query = new PostgresQuery(compilersWithDim, {
        measures: ['ledger2.ytd'],
        dimensions: ['ledger2.org_id'],
        timeDimensions: [{
          dimension: 'ledger2.data_dt',
          granularity: 'month',
          dateRange: ['2026-02-01', '2026-02-28'],
        }],
        timezone: 'UTC',
      });
      const [sql] = query.buildSqlAndParams();

      // org_id must be part of the PARTITION BY so running sums never mix members
      expect(sql).toMatch(
        /OVER \(PARTITION BY "ledger2__org_id", date_trunc\('year', "ledger2__data_dt_month"\)/
      );
    });

    it('to_date member composed with time_shift reads last year start..same period', async () => {
      const compilersShifted = prepareYamlCompiler(`
cubes:
  - name: ledger3
    sql: "SELECT 1 AS id, 10 AS amt, '2025-01-31'::timestamp AS data_dt
         UNION ALL SELECT 2, 20, '2025-03-31'"

    dimensions:
      - name: data_dt
        sql: data_dt
        type: time

    measures:
      - name: ptd
        type: sum
        sql: amt
      - name: lytd
        type: sum
        sql: "{ptd}"
        multi_stage: true
        rolling_window:
          type: to_date
          granularity: year
        time_shift:
          - time_dimension: data_dt
            interval: 1 year
            type: prior
`);
      await compilersShifted.compiler.compile();

      const query = new PostgresQuery(compilersShifted, {
        measures: ['ledger3.lytd'],
        timeDimensions: [{
          dimension: 'ledger3.data_dt',
          granularity: 'month',
          dateRange: ['2026-03-01', '2026-03-31'],
        }],
        timezone: 'UTC',
      });
      const sql = inlineParams(query.buildSqlAndParams());

      expect(sql).toMatch(/^\s*WITH\s+/i);
      // expanded range shifted back one year: the filter is expressed on the shifted
      // expression, so data_dt reads [2025-01-01, 2025-03-31] = [year start, same period]
      expect(sql).toMatch(/\+ interval '1 year'\) >= '2026-01-01T00:00:00\.000Z'::timestamptz/);
      expect(sql).toContain(
        `sum("ledger3__lytd") OVER (PARTITION BY date_trunc('year', "ledger3__data_dt_month") `
        + `ORDER BY "ledger3__data_dt_month") "ledger3__lytd"`
      );
    });

    it('builds unchanged SQL when no time granularity axis is present', async () => {
      await compilers.compiler.compile();

      const query = new PostgresQuery(compilers, {
        measures: ['ledger.ytd'],
        timeDimensions: [],
        timezone: 'UTC',
      });
      const [sql] = query.buildSqlAndParams();

      expect(sql).not.toMatch(/OVER \(PARTITION BY/);
      expect(sql).toContain('ledger__ytd');
    });
  });

  describe('multi-stage diff over rolling and plain members (last-period-acc shape)', () => {
    const compilers = prepareYamlCompiler(`
cubes:
  - name: ledger4
    sql: "SELECT 1 AS id, 10 AS amt, '2026-01-31'::timestamp AS data_dt
         UNION ALL SELECT 2, 20, '2026-02-28'
         UNION ALL SELECT 3, 30, '2026-03-31'"

    dimensions:
      - name: data_dt
        sql: data_dt
        type: time

    measures:
      - name: ptd
        type: sum
        sql: amt
      - name: ytd
        type: sum
        sql: "{ptd}"
        multi_stage: true
        rolling_window:
          type: to_date
          granularity: year
      - name: last_period_acc
        type: number
        sql: "{ytd} - {ptd}"
        multi_stage: true
`);

    it('diff stage reads the running-sum stage and builds valid SQL', async () => {
      await compilers.compiler.compile();

      const query = new PostgresQuery(compilers, {
        measures: ['ledger4.ptd', 'ledger4.last_period_acc'],
        timeDimensions: [{
          dimension: 'ledger4.data_dt',
          granularity: 'month',
          dateRange: ['2026-03-01', '2026-03-31'],
        }],
        timezone: 'UTC',
      });
      const [sql] = query.buildSqlAndParams();

      expect(sql).toMatch(/^\s*WITH\s+/i);
      // the referenced rolling member keeps its running-sum rendering
      expect(sql).toMatch(
        /sum\("ledger4__ytd"\) OVER \(PARTITION BY date_trunc\('year', "ledger4__data_dt_month"\)/
      );
      expect(sql).toContain('ledger4__last_period_acc');
    });
  });
});

describe('regularMeasuresSubQuery branch join pruning', () => {
  const compilers = prepareYamlCompiler(`
cubes:
  - name: ledger5
    sql: "SELECT 1 AS id, 'o1' AS org_id, 10 AS amt"

    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
      - name: org_id
        sql: org_id
        type: string

    measures:
      - name: amt
        type: sum
        sql: amt

    joins:
      - name: budget
        sql: "{CUBE}.org_id = {budget}.org_id"
        relationship: belongsTo

  - name: budget
    sql: "SELECT 'o1' AS org_id, 600 AS budget_val, 'IND001' AS ind_encode"

    dimensions:
      - name: org_id
        sql: org_id
        type: string
        primary_key: true
      - name: ind_encode
        sql: ind_encode
        type: string

    measures:
      - name: budget_val
        type: sum
        sql: budget_val
        filters:
          - sql: "{CUBE}.ind_encode = 'IND001'"
`);

  it('main branch drops the lookup-table join when only its own measures are aggregated', async () => {
    await compilers.compiler.compile();

    const query = new PostgresQuery(compilers, {
      measures: ['ledger5.amt', 'budget.budget_val'],
      dimensions: ['ledger5.org_id'],
      timeDimensions: [],
      timezone: 'UTC',
    });
    const [sql] = query.buildSqlAndParams();

    // main (regular-measure) branch aggregates ledger5 only — the budget join must not
    // fan out its rows; budget values come exclusively from the multiplied keys branch
    expect(sql).toContain('main__ledger5');
    expect(sql).not.toContain('main__budget');
    expect(sql).toContain('budget_key');
  });

  it('keeps the join when a queried dimension requires it in the main branch', async () => {
    await compilers.compiler.compile();

    const query = new PostgresQuery(compilers, {
      measures: ['ledger5.amt'],
      dimensions: ['budget.ind_encode'],
      timeDimensions: [],
      timezone: 'UTC',
    });
    const [sql] = query.buildSqlAndParams();

    // the main branch selects budget.ind_encode → the join is genuinely needed and kept
    expect(sql).toMatch(/LEFT JOIN \(SELECT 'o1' AS org_id, 600 AS budget_val, 'IND001' AS ind_encode\) AS "budget"/);
  });
});
