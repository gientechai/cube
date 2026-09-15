import { GBaseQuery } from '../../src/adapter/GBaseQuery';
import { prepareYamlCompiler } from './PrepareCompiler';

describe('GBaseQuery', () => {
  const compilers = prepareYamlCompiler(`
cubes:
  - name: metrics_facts
    sql: "SELECT 'Alpha' AS city, 150.5 AS amount, TIMESTAMP '2026-04-01 00:00:00' AS stat_dt"
    dimensions:
      - name: city
        sql: city
        type: string
      - name: stat_dt
        sql: stat_dt
        type: time
    measures:
      - name: trx_amount_flow
        type: sum
        sql: amount
      - name: period_daily_avg_data
        type: number
        sql: "{trx_amount_flow}"
        period_average:
          avg_unit: day
          interval: month
          denominator: data
          time_dimension: stat_dt
`);

  beforeAll(async () => {
    await compilers.compiler.compile();
  });

  it('day granularity avoids CONVERT_TZ and ISO-T datetime cast', async () => {
    const query = new GBaseQuery(
      { joinGraph: compilers.joinGraph, cubeEvaluator: compilers.cubeEvaluator, compiler: compilers.compiler },
      {
        measures: ['metrics_facts.trx_amount_flow'],
        timeDimensions: [{
          dimension: 'metrics_facts.stat_dt',
          granularity: 'day',
        }],
        order: [{ id: 'metrics_facts.stat_dt' }],
        timezone: 'UTC',
        useNativeSqlPlanner: false,
      },
    );

    const [sql] = query.buildSqlAndParams();
    expect(sql).not.toMatch(/CONVERT_TZ/i);
    expect(sql).not.toMatch(/T00:00:00\.000/);
    expect(sql).toMatch(/CAST\s*\(\s*DATE\s*\(/i);
  });

  it('replaces @@session.time_zone in convertTz SQL', async () => {
    const query = new GBaseQuery(
      { joinGraph: compilers.joinGraph, cubeEvaluator: compilers.cubeEvaluator, compiler: compilers.compiler },
      {
        measures: ['metrics_facts.trx_amount_flow'],
        dimensions: ['metrics_facts.city'],
        timezone: 'UTC',
      },
    );

    const [sql] = query.buildSqlAndParams();
    expect(sql).not.toMatch(/@@session\.time_zone/i);
  });

  it('groupByDimensionLimit is suppressed on multi-stage intermediate layers', () => {
    const query = new GBaseQuery(
      { joinGraph: compilers.joinGraph, cubeEvaluator: compilers.cubeEvaluator, compiler: compilers.compiler },
      {
        measures: ['metrics_facts.trx_amount_flow'],
        rowLimit: 4,
        disableExternalPreAggregations: true,
        timezone: 'UTC',
      },
    );

    expect(query.groupByDimensionLimit()).toBe('');
  });

  it('generated time series avoids nested WITH RECURSIVE', () => {
    const query = new GBaseQuery(
      { joinGraph: compilers.joinGraph, cubeEvaluator: compilers.cubeEvaluator, compiler: compilers.compiler },
      { timezone: 'UTC' },
    );
    const templates = query.sqlTemplates();
    expect(templates.statements.generated_time_series_select).toContain('CROSS JOIN');
    expect(templates.statements.generated_time_series_select).not.toContain('WITH RECURSIVE');
    expect(templates.statements.generated_time_series_with_cte_range_source).toContain('CROSS JOIN');
    expect(templates.statements.generated_time_series_with_cte_range_source).not.toContain('WITH RECURSIVE');
  });

  it('period_average data + dimension uses CTE column expression in ORDER BY', () => {
    const query = new GBaseQuery(
      { joinGraph: compilers.joinGraph, cubeEvaluator: compilers.cubeEvaluator, compiler: compilers.compiler },
      {
        measures: ['metrics_facts.period_daily_avg_data'],
        dimensions: ['metrics_facts.city'],
        timeDimensions: [{
          dimension: 'metrics_facts.stat_dt',
          dateRange: ['2026-04-01', '2026-04-30'],
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: false,
      },
    );

    const [sql] = query.buildSqlAndParams();
    expect(sql).toContain('period_avg_data_daily');
    expect(sql).toMatch(/ORDER BY[^]*SUM\(`__pa_sum_metrics_facts__period_daily_avg_data`\)/);
    expect(sql).not.toMatch(/ORDER BY[^]*`metrics_facts__period_daily_avg_data`\s+IS NULL/i);
  });

  it('uses short pa_b_ prefix for semi-additive period_average base columns', () => {
    const paQuery = new GBaseQuery(
      { joinGraph: compilers.joinGraph, cubeEvaluator: compilers.cubeEvaluator, compiler: compilers.compiler },
      {
        measures: ['metrics_facts.period_daily_avg_data'],
        timeDimensions: [{
          dimension: 'metrics_facts.stat_dt',
          granularity: 'month',
          dateRange: ['2026-04-01', '2026-04-30'],
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: false,
      },
    );
    const paMeasure = paQuery.measures.find((m) => m.measure.includes('period_daily_avg_data'));
    expect(paMeasure).toBeDefined();
    const alias = paQuery.periodAverageSemiAdditiveBaseColumnAlias(paMeasure!);
    expect(alias).toBe('`pa_b_period_daily_avg_data`');
    expect(alias.length).toBeLessThanOrEqual(64);
  });

  it('rolling YTD falls back from Tesseract to JS planner on GBase', async () => {
    const ytdCompiler = prepareYamlCompiler(`
cubes:
  - name: metrics_facts
    sql: "SELECT 150.5 AS amount, TIMESTAMP '2026-04-01 00:00:00' AS stat_dt"
    dimensions:
      - name: stat_dt
        sql: stat_dt
        type: time
    measures:
      - name: trx_amount_year_to_date
        type: sum
        sql: amount
        rolling_window:
          type: to_date
          granularity: year
`);
    await ytdCompiler.compiler.compile();
    const query = new GBaseQuery(
      { joinGraph: ytdCompiler.joinGraph, cubeEvaluator: ytdCompiler.cubeEvaluator, compiler: ytdCompiler.compiler },
      {
        measures: ['metrics_facts.trx_amount_year_to_date'],
        timeDimensions: [{
          dimension: 'metrics_facts.stat_dt',
          granularity: 'day',
          dateRange: ['2026-04-01', '2026-04-03'],
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: true,
      },
    );
    const [sql] = query.buildSqlAndParams();
    expect(sql).not.toMatch(/^\s*WITH\s+time_series/i);
    expect(sql).toMatch(/UNION ALL/i);
    expect(sql).toMatch(/`metrics_facts\.stat_dt_series`/i);
  });

  it('total aggregate measure filter wraps HAVING into outer WHERE', () => {
    const query = new GBaseQuery(
      { joinGraph: compilers.joinGraph, cubeEvaluator: compilers.cubeEvaluator, compiler: compilers.compiler },
      {
        measures: ['metrics_facts.trx_amount_flow'],
        filters: [{
          member: 'metrics_facts.trx_amount_flow',
          operator: 'gt',
          values: ['100'],
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: false,
      },
    );

    const [sql] = query.buildSqlAndParams();
    expect(sql).not.toMatch(/\bHAVING\b/i);
    expect(sql).toMatch(/WHERE[^]*`metrics_facts__trx_amount_flow`\s*>\s*\?/i);
  });

  it('multi-stage MoM over semi-additive flattens nested WITH via hoist', async () => {
    const momCompiler = prepareYamlCompiler(`
cubes:
  - name: gbase_loan
    sql_table: test_loan_detail
    dimensions:
      - name: data_date
        sql: data_date
        type: time
    measures:
      - name: balance_begin
        type: sum
        sql: loan_balance
        non_additive_dimension:
          name: data_date
          window_choice: min
      - name: balance_begin_last_month
        type: number
        sql: "{balance_begin}"
        multi_stage: true
        time_shift:
          - interval: 1 month
            type: prior
      - name: balance_begin_mom
        type: number
        sql: "({balance_begin} - {balance_begin_last_month}) / NULLIF({balance_begin_last_month}, 0)"
        multi_stage: true
`);
    await momCompiler.compiler.compile();
    const query = new GBaseQuery(
      {
        joinGraph: momCompiler.joinGraph,
        cubeEvaluator: momCompiler.cubeEvaluator,
        compiler: momCompiler.compiler,
      },
      {
        measures: ['gbase_loan.balance_begin_mom'],
        timeDimensions: [{
          dimension: 'gbase_loan.data_date',
          granularity: 'day',
          dateRange: ['2026-08-15', '2026-09-15'],
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: false,
      },
    );

    const [sql] = query.buildSqlAndParams();
    // Single top-level WITH; semi-additive CTEs hoisted beside cte_N.
    expect(sql).toMatch(/^WITH\b/i);
    expect((sql.match(/\bWITH\b/gi) || []).length).toBe(1);
    expect(sql).not.toMatch(/FROM\s*\(\s*WITH\b/i);
    expect(sql).not.toMatch(/\bAS\s*\(\s*WITH\b/i);
    expect(sql).toMatch(/\bbase_data_\d+\s+AS\b/i);
    expect(sql).toMatch(/\bmatched_data_\d+\s+AS\b/i);
    expect(sql).toMatch(/\bcte_\d+\s+AS\b/i);
    // Hoisted base_data appears before the cte that consumes it.
    const baseIdx = sql.search(/\bbase_data_\d+\s+AS\b/i);
    const cteIdx = sql.search(/\bcte_\d+\s+AS\b/i);
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(cteIdx).toBeGreaterThan(baseIdx);
  });
});
