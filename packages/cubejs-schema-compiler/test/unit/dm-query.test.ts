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
    expect(templates.statements.generated_time_series_select).toContain('CROSS JOIN');
    expect(templates.statements.generated_time_series_select).toContain('gen.lv');
    expect(templates.statements.generated_time_series_select).toContain('FROM DUAL');
    expect(templates.statements.generated_time_series_select).toContain('MONTHS_BETWEEN');
    expect(templates.statements.generated_time_series_select).toContain('CAST(ADD_MONTHS');
    expect(templates.statements.generated_time_series_select).not.toContain('WITH RECURSIVE');
    expect(templates.statements.generated_time_series_with_cte_range_source).toContain('CROSS JOIN');
    expect(templates.statements.generated_time_series_with_cte_range_source).toContain(') bounds');
    expect(templates.statements.generated_time_series_with_cte_range_source).toContain('gen.lv');
    expect(templates.statements.generated_time_series_with_cte_range_source).toContain('{{ range_source }}');
    expect(templates.statements.generated_time_series_with_cte_range_source).not.toContain('WITH RECURSIVE');
    expect(templates.functions.PERCENTILECONT).toBeUndefined();
    expect(templates.join_types.full).toBeUndefined();
    expect(templates.tesseract?.join_types_full).toBeUndefined();
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
    expect(sql).toMatch(/CROSS JOIN|CONNECT BY LEVEL|NUMTODSINTERVAL\(gen\.lv/);
    expect(sql).not.toMatch(/\bVALUES\b/);
    expect(sql).toMatch(/TRUNC.*YYYY/);
    expect(sql).not.toMatch(/\bFULL\s+(OUTER\s+)?JOIN\b/i);
  });

  it('Tesseract rolling window with dateRange and month granularity uses DATE-based ADD_MONTHS', async () => {
    const { compiler: rollingCompiler, joinGraph: rollingJoinGraph, cubeEvaluator: rollingCubeEvaluator } = prepareJsCompiler(
      `
      cube(\`visitors\`, {
        sql: \`SELECT 1 as visits, TIMESTAMP '2024-06-15' as dt UNION ALL SELECT 2, TIMESTAMP '2024-06-20' as dt\`,
        measures: {
          base: { type: 'sum', sql: 'visits' },
          rolling_mtd: {
            type: 'sum',
            sql: \`\${base}\`,
            multi_stage: true,
            rollingWindow: { type: 'to_date', granularity: 'month' }
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
        measures: ['visitors.rolling_mtd'],
        timeDimensions: [{
          dimension: 'visitors.dt',
          granularity: 'month',
          dateRange: ['2026-04-01', '2026-04-03'],
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: true,
      }
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/CAST\(ADD_MONTHS\(CAST\('2026-04-01' AS DATE\)/);
    expect(sql).toMatch(/CAST\(ADD_MONTHS\(CAST\('2026-04-01' AS DATE\), gen\.lv\) AS TIMESTAMP\) - NUMTODSINTERVAL\(1, 'SECOND'\)/);
    expect(sql).toMatch(/MONTHS_BETWEEN/);
    expect(sql).not.toMatch(/ADD_MONTHS\(CAST\('2026-04-01' AS TIMESTAMP\), gen\.lv\) - NUMTODSINTERVAL/);
    expect(sql).toMatch(/CAST\(TRUNC\([^)]*, 'MM'\) AS TIMESTAMP\)/);
  });

  it('Tesseract rolling window without dateRange uses generated time series from MIN/MAX', async () => {
    const { compiler: rollingCompiler, joinGraph: rollingJoinGraph, cubeEvaluator: rollingCubeEvaluator } = prepareJsCompiler(
      `
      cube(\`visitors\`, {
        sql: \`SELECT 1 as visits, TIMESTAMP '2024-06-15' as dt UNION ALL SELECT 2, TIMESTAMP '2024-06-20' as dt\`,
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
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: true,
      }
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/CROSS JOIN/);
    expect(sql).toMatch(/gen\.lv/);
    expect(sql).not.toMatch(/Date range is required for time series/);
    expect(sql).not.toMatch(/\bVALUES\b/);
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
    expect(sql).not.toMatch(/\bFULL\s+(OUTER\s+)?JOIN\b/i);
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
    expect(sql).toMatch(/CROSS JOIN|NUMTODSINTERVAL\(gen\.lv/);
    expect(sql).not.toMatch(/\bVALUES\b/);
  });

  describe('timeGroupedColumn (d6ef64c7 同环比 quarter/second + rolling TIMESTAMP 对齐)', () => {
    let query: DmQuery;

    beforeEach(async () => {
      await compiler.compile();
      query = new DmQuery(
        { joinGraph, cubeEvaluator, compiler },
        { measures: ['visitors.count'], timezone: 'UTC' }
      );
    });

    it('second 粒度仍走 TO_DATE(TO_CHAR)，不使用 TRUNC(..., ss)', () => {
      const expr = query.timeGroupedColumn('second', 'created_at');
      expect(expr).toBe(
        "TO_DATE(TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS'), 'YYYY-MM-DD HH24:MI:SS')"
      );
      expect(expr).not.toMatch(/TRUNC\([^)]*,\s*'ss'\)/i);
    });

    it('quarter 粒度使用 TRUNC(..., Q) 并 CAST 为 TIMESTAMP（DM 不支持 Oracle 默认 undefined 掩码）', () => {
      const expr = query.timeGroupedColumn('quarter', 'created_at');
      expect(expr).toBe("CAST(TRUNC(created_at, 'Q') AS TIMESTAMP)");
    });

    it('day/month/year 等非 second 粒度统一 CAST TRUNC 结果为 TIMESTAMP', () => {
      expect(query.timeGroupedColumn('day', 'dt')).toBe("CAST(TRUNC(dt, 'DD') AS TIMESTAMP)");
      expect(query.timeGroupedColumn('month', 'dt')).toBe("CAST(TRUNC(dt, 'MM') AS TIMESTAMP)");
      expect(query.timeGroupedColumn('year', 'dt')).toBe("CAST(TRUNC(dt, 'YYYY') AS TIMESTAMP)");
      expect(query.timeGroupedColumn('week', 'dt')).toBe("CAST(TRUNC(dt, 'IW') AS TIMESTAMP)");
    });

    it('无 granularity 时原样返回 dimension 表达式', () => {
      expect(query.timeGroupedColumn(undefined, 'created_at')).toBe('created_at');
    });
  });

  it('Tesseract 同比按 quarter 粒度可编译且使用 TRUNC(..., Q)', async () => {
    const { compiler: yoyCompiler, joinGraph: yoyJoinGraph, cubeEvaluator: yoyCubeEvaluator } = prepareJsCompiler(
      `
      cube(\`metrics\`, {
        sql: \`SELECT 100 amount, TIMESTAMP '2026-04-01 10:00:00' stat_dt FROM DUAL\`,
        measures: {
          amount: { type: 'sum', sql: 'amount' },
          amount_last_year: {
            type: 'number',
            sql: \`\${amount}\`,
            multi_stage: true,
            time_shift: [{ time_dimension: stat_dt, interval: '1 year', type: 'prior' }],
          },
          amount_yoy_ratio: {
            type: 'number',
            sql: \`CASE WHEN \${amount_last_year} <= 0 THEN NULL ELSE (\${amount} - \${amount_last_year}) / \${amount_last_year} END\`,
          },
        },
        dimensions: {
          stat_dt: { type: 'time', sql: 'stat_dt' },
        },
      })
      `,
      { adapter: 'dm' }
    );
    await yoyCompiler.compile();

    const query = new DmQuery(
      { joinGraph: yoyJoinGraph, cubeEvaluator: yoyCubeEvaluator, compiler: yoyCompiler },
      {
        measures: ['metrics.amount', 'metrics.amount_yoy_ratio'],
        timeDimensions: [{
          dimension: 'metrics.stat_dt',
          granularity: 'quarter',
          dateRange: ['2026-04-01', '2026-06-30'],
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: true,
      }
    );

    const [sql] = query.buildSqlAndParams();
    expect(sql).toMatch(/CAST\(TRUNC\([^)]*,\s*'Q'\) AS TIMESTAMP\)/);
    expect(sql).not.toMatch(/TRUNC\([^)]*,\s*'undefined'\)/);
    expect(sql).not.toMatch(/TRUNC\([^)]*,\s*'ss'\)/i);
  });

  it('Tesseract 同比按 second 粒度可编译且使用 TO_DATE(TO_CHAR)', async () => {
    const { compiler: yoyCompiler, joinGraph: yoyJoinGraph, cubeEvaluator: yoyCubeEvaluator } = prepareJsCompiler(
      `
      cube(\`metrics\`, {
        sql: \`SELECT 100 amount, TIMESTAMP '2026-04-01 10:00:00' stat_dt FROM DUAL\`,
        measures: {
          amount: { type: 'sum', sql: 'amount' },
          amount_last_year: {
            type: 'number',
            sql: \`\${amount}\`,
            multi_stage: true,
            time_shift: [{ time_dimension: stat_dt, interval: '1 year', type: 'prior' }],
          },
        },
        dimensions: {
          stat_dt: { type: 'time', sql: 'stat_dt' },
        },
      })
      `,
      { adapter: 'dm' }
    );
    await yoyCompiler.compile();

    const query = new DmQuery(
      { joinGraph: yoyJoinGraph, cubeEvaluator: yoyCubeEvaluator, compiler: yoyCompiler },
      {
        measures: ['metrics.amount', 'metrics.amount_last_year'],
        timeDimensions: [{
          dimension: 'metrics.stat_dt',
          granularity: 'second',
          dateRange: ['2026-04-01T10:00:00.000', '2026-04-01T10:00:59.000'],
        }],
        timezone: 'UTC',
        useNativeSqlPlanner: true,
      }
    );

    const [sql] = query.buildSqlAndParams();
    expect(sql).toMatch(/TO_DATE\(TO_CHAR\([^)]*, 'YYYY-MM-DD HH24:MI:SS'\), 'YYYY-MM-DD HH24:MI:SS'\)/);
    expect(sql).not.toMatch(/TRUNC\([^)]*,\s*'ss'\)/i);
  });

  it('day 粒度基础查询仍使用 CAST(TRUNC(..., DD) AS TIMESTAMP)，与 timeStampCast 边界类型一致', async () => {
    await compiler.compile();
    const query = new DmQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['visitors.count'],
        timeDimensions: [{
          dimension: 'visitors.createdAt',
          granularity: 'day',
          dateRange: ['2024-02-01', '2024-02-02'],
        }],
        timezone: 'UTC',
      }
    );

    const [sql] = query.buildSqlAndParams();
    expect(sql).toMatch(/CAST\(TRUNC\([^)]*, 'DD'\) AS TIMESTAMP\)/);
    expect(sql).toMatch(/created_at\s+>=\s+CAST\(TO_TIMESTAMP_TZ/);
  });
});
