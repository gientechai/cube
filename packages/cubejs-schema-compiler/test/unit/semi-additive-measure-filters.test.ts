/* eslint-disable no-restricted-syntax */
import { DmQuery } from '../../src/adapter/DmQuery';
import { MysqlQuery } from '../../src/adapter/MysqlQuery';
import { OracleQuery } from '../../src/adapter/OracleQuery';
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { prepareJsCompiler } from './PrepareCompiler';

/** JOIN 路径用 matched_data，窗口路径用 windowed_data */
const expectSemiAdditiveCtePath = (sql: string) => {
  expect(sql).toMatch(/WITH base_data AS/i);
  expect(sql).toMatch(/windowed_data|matched_data/i);
};

const expectPaSemiAdditiveSumDivisorSql = (sql: string, paMeasureSuffix: string) => {
  expect(sql).toMatch(new RegExp(`__pa_base_[^\\s,)]+${paMeasureSuffix}`, 'i'));
  expect(sql).toMatch(
    new RegExp(
      'SUM\\s*\\(?\\s*["\']__pa_base_[^"\']+["\']\\s*\\)?\\s*\\)?\\s*\\/\\s*NULLIF',
      'i',
    ),
  );
};

const expectNoMainTableInSemiAdditiveOuterAggregation = (sql: string) => {
  expect(sql).not.toMatch(/FROM windowed_data[\s\S]*main__/i);
  expect(sql).not.toMatch(/FROM matched_data[\s\S]*main__/i);
};

describe('semi-additive measure schema filters', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(`
    cube(\`score1\`, {
      sql: \`SELECT * FROM xss.student_scores\`,

      dimensions: {
        examDate: {
          sql: \`\${CUBE}.exam_date\`,
          type: 'time',
        },
        subject: {
          sql: \`\${CUBE}.subject\`,
          type: 'string',
        },
      },

      measures: {
        meChineseScoreEnd: {
          sql: \`\${CUBE}.score\`,
          type: 'sum',
          filters: [{
            sql: \`\${CUBE}.subject = '语文'\`,
          }],
          nonAdditiveDimension: {
            name: 'examDate',
            windowChoice: 'max',
          },
        },
      },
    })
  `);

  it('applies schema filters to semi-additive raw column only', async () => {
    await compiler.compile();

    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['score1.meChineseScoreEnd'],
        timeDimensions: [{
          dimension: 'score1.examDate',
          granularity: 'year',
        }],
        timezone: 'Pacific/Midway',
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/CASE WHEN .*subject.*=.*'语文'.*THEN.*score/i);
    // 期初/期末时点在同一时间桶内全局统一；filter 只收窄 raw 取值，边界 min/max 仍看全部分区行
    // JOIN 路径：partition_bounds 上 MAX(...)，不再使用 OVER
    expect(sql).toMatch(/MAX\("_score1__exam_date_for_ordering"\)/i);
    expect(sql).toMatch(/partition_bounds_/i);
    expect(sql).toMatch(/matched_data AS/i);
    expect(sql).not.toMatch(/MAX\(CASE WHEN.*_raw IS NOT NULL/i);
    expect(sql).not.toMatch(/OVER\s*\(/i);
  });
});

describe('semi-additive calculated measure references', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(`
    cube(\`score1\`, {
      sql: \`SELECT * FROM xss.student_scores\`,

      dimensions: {
        examDate: {
          sql: \`\${CUBE}.exam_date\`,
          type: 'time',
        },
        subject: {
          sql: \`\${CUBE}.subject\`,
          type: 'string',
        },
      },

      measures: {
        sdggg: {
          sql: \`\${CUBE}.score\`,
          type: 'sum',
          nonAdditiveDimension: {
            name: 'examDate',
            windowChoice: 'max',
          },
        },
        qcjs: {
          sql: \`\${CUBE}.score\`,
          type: 'count_distinct',
          nonAdditiveDimension: {
            name: 'examDate',
            windowChoice: 'min',
          },
        },
        fuhezhibiao: {
          type: 'number',
          sql: \`\${sdggg} / \${qcjs}\`,
        },
      },
    })
  `);

  it('uses semi-additive CTE when querying a calculated measure that references semi-additive measures', async () => {
    await compiler.compile();

    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['score1.fuhezhibiao'],
        dimensions: ['score1.subject'],
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/matched_data AS/i);
    expect(sql).toMatch(/partition_bounds_/i);
    expect(sql).toMatch(/MAX\("_score1__exam_date_for_ordering"\)/i);
    expect(sql).toMatch(/MIN\("_score1__exam_date_for_ordering"\)/i);
    expect(sql).not.toMatch(/OVER\s*\(/i);
    expect(sql).not.toMatch(/sum\("score1"\.score\)\s*\/\s*count\(distinct "score1"\.score\)/i);
  });

  it('orders calculated semi-additive measure by alias on MySQL (q_0 wrap)', async () => {
    await compiler.compile();

    const query = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['score1.fuhezhibiao'],
        dimensions: ['score1.subject'],
        order: [{ id: 'score1.fuhezhibiao', desc: true }],
        limit: 100,
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/AS q_0[\s\S]*ORDER BY `score1__fuhezhibiao` IS NULL ASC, `score1__fuhezhibiao` DESC/i);
    expect(sql).not.toMatch(/ORDER BY[\s\S]*sum\("score1"\.score\)/i);
  });

  it('orders calculated semi-additive measure by alias on Postgres (q_0 wrap)', async () => {
    await compiler.compile();

    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['score1.fuhezhibiao'],
        dimensions: ['score1.subject'],
        order: [{ id: 'score1.fuhezhibiao', desc: true }],
        limit: 100,
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/(?:AS )?q_0[\s\S]*ORDER BY "score1__fuhezhibiao" DESC NULLS LAST/i);
    expect(sql).not.toMatch(/ORDER BY[\s\S]*sum\("score1"\.score\)/i);
  });

  it('orders calculated semi-additive measure by alias on DM (q_0 wrap)', async () => {
    await compiler.compile();

    const query = new DmQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['score1.fuhezhibiao'],
        dimensions: ['score1.subject'],
        order: [{ id: 'score1.fuhezhibiao', desc: true }],
        limit: 100,
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/(?:AS )?q_0[\s\S]*ORDER BY "score1__fuhezhibiao" DESC NULLS LAST/i);
    expect(sql).not.toMatch(/ORDER BY[\s\S]*sum\("score1"\.score\)/i);
  });

  it('orders calculated semi-additive measure by alias on Oracle (hoists WITH above q_0)', async () => {
    await compiler.compile();

    const query = new OracleQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['score1.fuhezhibiao'],
        dimensions: ['score1.subject'],
        order: [{ id: 'score1.fuhezhibiao', desc: true }],
        limit: 100,
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/^WITH base_data AS/i);
    expect(sql).toMatch(/matched_data AS/i);
    expect(sql).toMatch(/partition_bounds_/i);
    expect(sql).not.toMatch(/FROM\s*\(\s*WITH/i);
    expect(sql).toMatch(/q_0[\s\S]*ORDER BY "score1__fuhezhibiao" DESC NULLS LAST/i);
    expect(sql).not.toMatch(/ORDER BY[\s\S]*sum\("score1"\.score\)/i);
  });
});

describe('semi-additive multiple time granularities in base_data', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(`
    cube(\`loan_detail_1\`, {
      sql_table: \`loan_stand_book_detail_list_320\`,

      dimensions: {
        distr_date: {
          sql: \`\${CUBE}.distr_date\`,
          type: 'time',
        },
        cust_type: {
          sql: \`\${CUBE}.cust_type\`,
          type: 'string',
        },
      },

      measures: {
        loan_bal1: {
          type: 'sum',
          sql: 'loan_bal',
          filters: [{ sql: \`\${CUBE}.cust_type = '民营企业'\` }],
          nonAdditiveDimension: {
            name: 'distr_date',
            windowChoice: 'min',
          },
        },
        xxsxaw: {
          type: 'sum',
          sql: 'loan_bal',
          filters: [{ sql: \`\${CUBE}.cust_type = '外资企业'\` }],
          nonAdditiveDimension: {
            name: 'distr_date',
            windowChoice: 'min',
          },
        },
        fu_11: {
          type: 'number',
          sql: \`(\${loan_bal1} + \${xxsxaw}) / 2\`,
        },
      },
    })
  `);

  it('projects all time granularities into base_data for composite semi-additive measures', async () => {
    await compiler.compile();

    const query = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['loan_detail_1.fu_11'],
        filters: [{
          member: 'loan_detail_1.distr_date',
          operator: 'inDateRange',
          values: ['2026-06-01', '2026-07-02'],
        }],
        timeDimensions: [
          { dimension: 'loan_detail_1.distr_date', granularity: 'day' },
          { dimension: 'loan_detail_1.distr_date', granularity: 'month' },
        ],
        order: [{ id: 'loan_detail_1.distr_date', desc: false }],
        limit: 100,
        timezone: 'UTC',
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/`loan_detail_1__distr_date_day`/i);
    expect(sql).toMatch(/`loan_detail_1__distr_date_month`/i);
    expect(sql).toMatch(/SELECT `loan_detail_1__distr_date_day`, `loan_detail_1__distr_date_month`/i);
    expect(sql).not.toMatch(/Unknown column/i);
  });

  it('partitions semi-additive window by finest granularity when year and month are both queried', async () => {
    await compiler.compile();

    const query = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['loan_detail_1.fu_11'],
        filters: [{
          member: 'loan_detail_1.distr_date',
          operator: 'inDateRange',
          values: ['2026-03-01', '2026-04-03'],
        }],
        timeDimensions: [
          { dimension: 'loan_detail_1.distr_date', granularity: 'year' },
          { dimension: 'loan_detail_1.distr_date', granularity: 'month' },
        ],
        timezone: 'UTC',
      },
    );

    const [sql] = query.buildSqlAndParams();

    // JOIN 路径：bounds GROUP BY 用最细粒度（month），year 仅作为展示列出现在 SELECT
    expect(sql).toMatch(/partition_bounds_/i);
    expect(sql).toMatch(
      /partition_bounds_0 AS \(\s*SELECT[\s\S]*%Y-%m-01[\s\S]*GROUP BY[\s\S]*%Y-%m-01/i
    );
    expect(sql).not.toMatch(
      /partition_bounds_0 AS \(\s*SELECT[\s\S]*%Y-01-01T00:00:00\.000/i
    );
    expect(sql).not.toMatch(/OVER\s*\(/i);
  });
});

describe('semi-additive windowGroupings dimensions in base_data', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(`
    cube(\`facts\`, {
      sql: \`SELECT * FROM xss.cube_metrics_facts\`,

      dimensions: {
        city: {
          sql: \`\${CUBE}.city\`,
          type: 'string',
        },
        cityCode: {
          sql: \`\${CUBE}.city_code\`,
          type: 'string',
        },
        statDt: {
          sql: \`\${CUBE}.stat_dt\`,
          type: 'time',
        },
      },

      measures: {
        balanceEnd: {
          sql: \`\${CUBE}.balance_snapshot\`,
          type: 'sum',
          nonAdditiveDimension: {
            name: 'statDt',
            windowChoice: 'max',
            windowGroupings: ['city'],
          },
        },
      },
    })
  `);

  it('projects windowGroupings dimensions into base_data even when not in query dimensions', async () => {
    await compiler.compile();

    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['facts.balanceEnd'],
        dimensions: ['facts.cityCode'],
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/"facts__city"/i);
    expect(sql).toMatch(/"facts__city_code"/i);
    expect(sql).toMatch(/partition_bounds_/i);
    expect(sql).toMatch(/matched_data AS/i);
    // windowGroupings 进入 bounds 的 GROUP BY（JOIN 路径不再使用 PARTITION BY）
    expect(sql).toMatch(/GROUP BY[\s\S]*"facts__city"/i);
    expect(sql).not.toMatch(/OVER\s*\(/i);
  });
});

describe('period_average with semi-additive base measure', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(`
    cube(\`facts\`, {
      sql: \`SELECT * FROM xss.cube_metrics_facts\`,

      dimensions: {
        statDt: {
          sql: \`\${CUBE}.stat_dt\`,
          type: 'time',
        },
      },

      measures: {
        balanceEnd: {
          sql: \`\${CUBE}.balance_snapshot\`,
          type: 'sum',
          nonAdditiveDimension: {
            name: 'statDt',
            windowChoice: 'max',
          },
        },
        periodDailyAvg: {
          type: 'number',
          sql: \`\${balanceEnd}\`,
          period_average: {
            avg_unit: 'day',
            interval: 'month',
            denominator: 'calendar',
            time_dimension: 'statDt',
          },
        },
      },
    })
  `);

  beforeAll(async () => {
    await compiler.compile();
  });

  it('compile infers baseMeasure from sql for Tesseract bridge', () => {
    const def = cubeEvaluator.measureByPath('facts.periodDailyAvg');
    const pa = def.period_average || def.periodAverage;
    expect(pa?.baseMeasure).toBe('facts.balanceEnd');
    expect(pa?.baseAggType).toBe('sum');
  });

  it('only period_average selected → no semi-additive CTE, numerator uses SUM', () => {
    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['facts.periodDailyAvg'],
        timeDimensions: [{
          dimension: 'facts.statDt',
          granularity: 'month',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).not.toMatch(/WITH base_data AS/i);
    expect(sql).not.toMatch(/windowed_data/i);
    expect(sql).toMatch(/SUM\s*\(/i);
    expect(sql).not.toMatch(/OVER\s*\(/i);
    expect(sql).toMatch(/NULLIF/i);
  });

  it('balanceEnd + period_average together → balanceEnd semi-additive, PA numerator still SUM', () => {
    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['facts.balanceEnd', 'facts.periodDailyAvg'],
        timeDimensions: [{
          dimension: 'facts.statDt',
          granularity: 'month',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      },
    );

    const [sql] = query.buildSqlAndParams();

    expectSemiAdditiveCtePath(sql);
    expect(sql).toMatch(/SUM\s*\(/i);
    expect(sql).toMatch(/NULLIF/i);
    expect(sql).toMatch(/__pa_base_facts__period_daily_avg/i);
    expectPaSemiAdditiveSumDivisorSql(sql, 'period_daily_avg');
    expect(sql).not.toMatch(/MIN\(date_trunc\('month',\s*\("main__facts"/i);
    expect(sql).not.toMatch(/sum\("main__facts"\.balance_snapshot\).*period_daily_avg/is);
  });
});

describe('period_average + explicit semi-additive measure (regular sum base)', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(`
    cube(\`facts\`, {
      sql: \`SELECT * FROM xss.cube_metrics_facts\`,

      dimensions: {
        statDt: {
          sql: \`\${CUBE}.stat_dt\`,
          type: 'time',
        },
      },

      measures: {
        balanceBegin: {
          sql: \`\${CUBE}.balance_snapshot\`,
          type: 'sum',
          nonAdditiveDimension: {
            name: 'statDt',
            windowChoice: 'min',
          },
        },
        trxAmount: {
          sql: \`\${CUBE}.amount\`,
          type: 'sum',
        },
        periodDailyAvgCalendar: {
          type: 'number',
          sql: \`\${trxAmount}\`,
          period_average: {
            avg_unit: 'day',
            interval: 'month',
            denominator: 'calendar',
            time_dimension: 'statDt',
          },
        },
        periodDailyAvgData: {
          type: 'number',
          sql: \`\${trxAmount}\`,
          period_average: {
            avg_unit: 'day',
            interval: 'month',
            denominator: 'data',
            time_dimension: 'statDt',
          },
        },
      },
    })
  `);

  beforeAll(async () => {
    await compiler.compile();
  });

  it('balanceBegin + periodDailyAvgCalendar → PA uses __pa_base column, not main__ table in semi-additive CTE', () => {
    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['facts.balanceBegin', 'facts.periodDailyAvgCalendar'],
        timeDimensions: [{
          dimension: 'facts.statDt',
          granularity: 'month',
          dateRange: ['2026-04-01', '2026-04-30'],
        }],
        timezone: 'UTC',
      },
    );

    const [sql] = query.buildSqlAndParams();

    expectSemiAdditiveCtePath(sql);
    expect(sql).toMatch(/__pa_base_facts__period_daily_avg_calendar/i);
    expectPaSemiAdditiveSumDivisorSql(sql, 'period_daily_avg_calendar');
    expect(sql).not.toMatch(/sum\("main__facts"\.amount\)/i);
    expectNoMainTableInSemiAdditiveOuterAggregation(sql);
  });

  it('balanceBegin + periodDailyAvgData uses row-level stat_dt for data divisor in CTE', () => {
    const query = new PostgresQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['facts.balanceBegin', 'facts.periodDailyAvgData'],
        timeDimensions: [{
          dimension: 'facts.statDt',
          granularity: 'month',
          dateRange: ['2026-04-01', '2026-04-30'],
        }],
        timezone: 'UTC',
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/COUNT\(DISTINCT[\s\S]*facts__stat_dt/i);
    expect(sql).not.toMatch(/COUNT\(DISTINCT[\s\S]*\(stat_dt::timestamptz/i);
  });
});
