/* eslint-disable no-restricted-syntax */
import { DmQuery } from '../../src/adapter/DmQuery';
import { prepareJsCompiler } from './PrepareCompiler';

describe('DmQuery', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(
    `
    cube(\`visitors\`, {
      sql: \`select * from visitors\`,
      measures: {
        count: {
          type: 'count'
        }
      },
      dimensions: {
        createdAt: {
          type: 'time',
          sql: 'created_at'
        }
      }
    })
    `,
    { adapter: 'dm' }
  );

  it('casts time range binds to TIMESTAMP (not TZ) so DM avoids type mismatch vs time columns', async () => {
    await compiler.compile();

    const query = new DmQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['visitors.count'],
        timeDimensions: [
          {
            dimension: 'visitors.createdAt',
            dateRange: ['2024-02-01', '2024-02-02'],
            granularity: 'day',
          },
        ],
        timezone: 'UTC',
      }
    );

    const [sql, params] = query.buildSqlAndParams();

    expect(sql).toMatch(
      /created_at\s+>=\s+CAST\(TO_TIMESTAMP_TZ\(:"[^"]*",\s*'YYYY-MM-DD"T"HH24:MI:SS\.FF"Z"'\)\s+AS\s+TIMESTAMP\)/
    );
    expect(sql).toMatch(
      /created_at\s+<=\s+CAST\(TO_TIMESTAMP_TZ\(:"[^"]*",\s*'YYYY-MM-DD"T"HH24:MI:SS\.FF"Z"'\)\s+AS\s+TIMESTAMP\)/
    );
    expect(params).toEqual(['2024-02-01T00:00:00.000Z', '2024-02-02T23:59:59.999Z']);
  });

  it('uses numeric day +/- for whole-day offsets (avoids TIMESTAMP from NUMTODSINTERVAL)', async () => {
    await compiler.compile();
    const query = new DmQuery(
      { joinGraph, cubeEvaluator, compiler },
      { measures: ['visitors.count'], timezone: 'UTC' }
    );

    expect(query.addInterval('visit_date', '1 day')).toBe('visit_date + 1');
    expect(query.subtractInterval('visit_date', '2 day')).toBe('visit_date - 2');
    expect(query.addInterval('visit_date', '1 day 3 hour')).toContain('NUMTODSINTERVAL');

    expect(query.addInterval('visit_date', '1 year 2 day')).toBe(`ADD_MONTHS(visit_date, 12) + 2`);
  });

  it('sqlTemplates use column expressions for Tesseract GROUP BY/ORDER BY and DM time_series casts', async () => {
    await compiler.compile();
    const query = new DmQuery(
      { joinGraph, cubeEvaluator, compiler },
      { measures: ['visitors.count'], timezone: 'UTC' }
    );
    const templates = query.sqlTemplates();

    expect(templates.statements.group_by_exprs).toContain("attribute='expr'");
    expect(templates.statements.group_by_exprs).not.toContain("attribute='index'");
    expect(templates.expressions.order_by).toContain('{{ expr }}');
    expect(templates.expressions.order_by).not.toContain('index');
    expect(templates.statements.time_series_select).toContain('FROM DUAL');
    expect(templates.statements.time_series_select).toContain('UNION ALL');
    expect(templates.statements.time_series_select).toContain('TO_TIMESTAMP_TZ');
    expect(templates.statements.time_series_select).not.toContain('VALUES');
    expect(templates.statements.time_series_select).not.toContain('::timestamp');
    expect(templates.functions.PERCENTILECONT).toBeUndefined();
  });

  it('Tesseract planner does not emit ordinal GROUP BY for rolling multi-stage measures', async () => {
    const { compiler: rollingCompiler, joinGraph: rollingJoinGraph, cubeEvaluator: rollingCubeEvaluator } = prepareJsCompiler(
      `
      cube(\`visitors\`, {
        sql: \`SELECT 1 as visits, TIMESTAMP '2024-06-15' as dt UNION ALL SELECT 2, TIMESTAMP '2024-06-20'\`,
        measures: {
          base: { type: 'sum', sql: 'visits' },
          rolling_ytd: {
            type: 'sum',
            sql: \`\${base}\`,
            multi_stage: true,
            rollingWindow: { type: 'to_date', granularity: 'year' }
          }
        },
        dimensions: {
          dt: { type: 'time', sql: 'dt' }
        }
      })
      `,
      { adapter: 'dm' }
    );
    await rollingCompiler.compile();

    const query = new DmQuery(
      { joinGraph: rollingJoinGraph, cubeEvaluator: rollingCubeEvaluator, compiler: rollingCompiler },
      {
        measures: ['visitors.rolling_ytd'],
        timeDimensions: [{
          dimension: 'visitors.dt',
          granularity: 'month',
          dateRange: ['2024-01-01', '2024-12-31'],
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: true,
      }
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).not.toMatch(/GROUP BY\s+1\b/);
    expect(sql).toMatch(/FROM DUAL/);
    expect(sql).not.toMatch(/\bVALUES\b/);
    expect(sql).toMatch(/TRUNC.*YYYY/);
  });

  it('JS planner rolling window uses UNION ALL FROM DUAL instead of VALUES', async () => {
    const { compiler: rollingCompiler, joinGraph: rollingJoinGraph, cubeEvaluator: rollingCubeEvaluator } = prepareJsCompiler(
      `
      cube(\`visitors\`, {
        sql: \`SELECT 1 as visits, TIMESTAMP '2024-06-15' as dt UNION ALL SELECT 2, TIMESTAMP '2024-06-20'\`,
        measures: {
          rolling_ytd: {
            type: 'sum',
            sql: 'visits',
            rollingWindow: { type: 'to_date', granularity: 'year' }
          }
        },
        dimensions: {
          dt: { type: 'time', sql: 'dt' }
        }
      })
      `,
      { adapter: 'dm' }
    );
    await rollingCompiler.compile();

    const query = new DmQuery(
      { joinGraph: rollingJoinGraph, cubeEvaluator: rollingCubeEvaluator, compiler: rollingCompiler },
      {
        measures: ['visitors.rolling_ytd'],
        timeDimensions: [{
          dimension: 'visitors.dt',
          granularity: 'month',
          dateRange: ['2024-01-01', '2024-12-31'],
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: false,
      }
    );

    const [sql] = query.buildSqlAndParams();
    expect(sql).toMatch(/FROM DUAL/);
    expect(sql).not.toMatch(/\bVALUES\b/);
  });

  it('does not emit FETCH NEXT inside multi-stage CTE bodies (DM rejects FETCH on subquery FROM)', async () => {
    const { compiler: metricsCompiler, joinGraph: metricsJoinGraph, cubeEvaluator: metricsCubeEvaluator } = prepareJsCompiler(
      `
      cube(\`dmmetrics_facts\`, {
        sql: \`SELECT 'North' AS region, 100 AS amount FROM DUAL UNION ALL SELECT 'South', 200 FROM DUAL\`,
        dimensions: {
          region: { sql: 'region', type: 'string' },
        },
        measures: {
          filtered_ns_amount: {
            type: 'sum',
            sql: 'amount',
            filters: [{ sql: \`\${CUBE}.region IN ('North', 'South')\` }],
          },
          filtered_ns_amount_total: {
            type: 'sum',
            sql: \`\${filtered_ns_amount}\`,
            multi_stage: true,
          },
          filtered_ns_amount_share: {
            type: 'number',
            sql: \`\${filtered_ns_amount} / \${filtered_ns_amount_total}\`,
            multi_stage: true,
          },
        },
      })
      `,
      { adapter: 'dm' }
    );
    await metricsCompiler.compile();

    const query = new DmQuery(
      { joinGraph: metricsJoinGraph, cubeEvaluator: metricsCubeEvaluator, compiler: metricsCompiler },
      {
        measures: ['dmmetrics_facts.filtered_ns_amount_share'],
        rowLimit: 10000,
      }
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/^\s*WITH\s+/i);
    const cteSection = sql.replace(/\s*SELECT\s+\*\s+FROM\s+cte_\d+[\s\S]*$/i, '');
    expect(cteSection).not.toMatch(/FETCH\s+NEXT/i);
    expect(sql).toMatch(/FETCH\s+NEXT\s+10000\s+ROWS\s+ONLY\s*$/i);
  });

  it('promotes inDateRange filter to timeDimensions.dateRange for Tesseract rolling window', async () => {
    const { compiler: rollingCompiler, joinGraph: rollingJoinGraph, cubeEvaluator: rollingCubeEvaluator } = prepareJsCompiler(
      `
      cube(\`visitors\`, {
        sql: \`SELECT 1 as visits, TIMESTAMP '2024-06-15' as dt UNION ALL SELECT 2, TIMESTAMP '2024-06-20'\`,
        measures: {
          base: { type: 'sum', sql: 'visits' },
          rolling_ytd: {
            type: 'sum',
            sql: \`\${base}\`,
            multi_stage: true,
            rollingWindow: { type: 'to_date', granularity: 'year' }
          }
        },
        dimensions: {
          dt: { type: 'time', sql: 'dt' }
        }
      })
      `,
      { adapter: 'dm' }
    );
    await rollingCompiler.compile();

    const query = new DmQuery(
      { joinGraph: rollingJoinGraph, cubeEvaluator: rollingCubeEvaluator, compiler: rollingCompiler },
      {
        measures: ['visitors.rolling_ytd'],
        filters: [{
          member: 'visitors.dt',
          operator: 'inDateRange',
          values: ['2024-01-01', '2024-12-31'],
        }],
        timeDimensions: [{
          dimension: 'visitors.dt',
          granularity: 'month',
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: true,
      }
    );

    expect(query.timeDimensions[0].dateRange).toEqual(['2024-01-01', '2024-12-31']);

    const [sql] = query.buildSqlAndParams();
    expect(sql).toMatch(/2024-01-01/);
    expect(sql).not.toMatch(/GROUP BY\s+1\b/);
    expect(sql).toMatch(/FROM DUAL/);
    expect(sql).not.toMatch(/\bVALUES\b/);
  });
});
