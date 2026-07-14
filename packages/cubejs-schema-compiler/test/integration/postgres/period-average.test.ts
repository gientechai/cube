import { getEnv } from '@cubejs-backend/shared';
import { PostgresQuery } from '../../../src/adapter/PostgresQuery';
import { prepareJsCompiler } from '../../unit/PrepareCompiler';
import { dbRunner } from './PostgresDBRunner';

/**
 * period_average 需求验收矩阵（§15）：
 *
 * | # | denominator | avg_unit / interval | 查看 | granularity | filter              | 期望              |
 * |---|-------------|---------------------|------|-------------|---------------------|-------------------|
 * | 1 | calendar    | day / month         | 整区间 | month       | 2025-06             | SUM÷30            |
 * | 2 | calendar    | day / month         | 整区间 | month       | 2025-07             | SUM÷31（整月自然日）|
 * | 3 | data        | day / month         | 整区间 | month       | 2025-07（7/11–12 无数据）| SUM÷11        |
 * | 4 | calendar    | month / month       | B    | —           | 2025-04-01~06-30    | 1 行；SUM÷3       |
 * | 5 | data        | month / month       | B    | —           | 2025-04-01~06-30    | 1 行；SUM÷2       |
 * | 6 | calendar    | month / month       | 整区间 | month       | 本月                | SUM÷1             |
 * | 7 | calendar    | month / year        | 整区间 | year        | 2025 全年           | SUM÷12            |
 * | 8 | sum 引用    | day / month         | 整区间 | month       | 2025-06             | calendar≠data 值  |
 * | 9 | avg 引用    | day / month         | 整区间 | month       | 2025-06             | AVG÷分母≠SUM÷分母 |
 * |10 | —           | day / month         | —    | week        | —                   | 报错              |
 * |11 | calendar    | day / month         | 累计 | day         | 2025-06             | 区间内按日累计    |
 * |12 | —           | day / month         | —    | year        | 2025                | 报错              |
 *
 * frozen now = 2025-07-13（CUBEJS_TEST_NOW）。
 */
const PERIOD_AVG_SCHEMA = `
    cube(\`period_avg_facts\`, {
      sql: \`
        SELECT * FROM (
          VALUES
            (1, 100::numeric, TIMESTAMP '2025-04-01 10:00:00'),
            (2, 100::numeric, TIMESTAMP '2025-06-01 10:00:00'),
            (3, 200::numeric, TIMESTAMP '2025-06-15 10:00:00'),
            (4, 300::numeric, TIMESTAMP '2025-06-30 10:00:00'),
            (5, 100::numeric, TIMESTAMP '2025-07-01 10:00:00'),
            (6, 100::numeric, TIMESTAMP '2025-07-02 10:00:00'),
            (7, 100::numeric, TIMESTAMP '2025-07-03 10:00:00'),
            (8, 100::numeric, TIMESTAMP '2025-07-04 10:00:00'),
            (9, 100::numeric, TIMESTAMP '2025-07-05 10:00:00'),
            (10, 100::numeric, TIMESTAMP '2025-07-06 10:00:00'),
            (11, 100::numeric, TIMESTAMP '2025-07-07 10:00:00'),
            (12, 100::numeric, TIMESTAMP '2025-07-08 10:00:00'),
            (13, 100::numeric, TIMESTAMP '2025-07-09 10:00:00'),
            (14, 100::numeric, TIMESTAMP '2025-07-10 10:00:00'),
            (15, 300::numeric, TIMESTAMP '2025-07-13 10:00:00'),
            (16, 10::numeric, TIMESTAMP '2025-01-15 10:00:00'),
            (17, 10::numeric, TIMESTAMP '2025-02-15 10:00:00'),
            (18, 10::numeric, TIMESTAMP '2025-03-15 10:00:00')
        ) AS t(id, amount, created_at)
      \`,
      joins: {},
      measures: {
        total_amount: { type: 'sum', sql: 'amount' },
        avg_amount: { type: 'avg', sql: 'amount' },
        period_daily_avg_calendar: {
          type: 'number',
          sql: \`\${total_amount}\`,
          period_average: { avg_unit: 'day', interval: 'month', denominator: 'calendar', time_dimension: 'created_at' },
        },
        period_daily_avg_data: {
          type: 'number',
          sql: \`\${total_amount}\`,
          period_average: { avg_unit: 'day', interval: 'month', denominator: 'data', time_dimension: 'created_at' },
        },
        period_daily_avg_from_avg: {
          type: 'number',
          sql: \`\${avg_amount}\`,
          period_average: { avg_unit: 'day', interval: 'month', denominator: 'calendar', time_dimension: 'created_at' },
        },
        period_monthly_avg_calendar: {
          type: 'number',
          sql: \`\${total_amount}\`,
          period_average: { avg_unit: 'month', interval: 'month', denominator: 'calendar', time_dimension: 'created_at' },
        },
        period_monthly_avg_data: {
          type: 'number',
          sql: \`\${total_amount}\`,
          period_average: { avg_unit: 'month', interval: 'month', denominator: 'data', time_dimension: 'created_at' },
        },
        period_monthly_in_year_avg_calendar: {
          type: 'number',
          sql: \`\${total_amount}\`,
          period_average: { avg_unit: 'month', interval: 'year', denominator: 'calendar', time_dimension: 'created_at' },
        },
      },
      dimensions: {
        id: { type: 'number', sql: 'id', primaryKey: true },
        created_at: { type: 'time', sql: 'created_at' },
      },
      preAggregations: {},
    })
`;

describe('PostgresPeriodAverage', () => {
  jest.setTimeout(200000);

  const FROZEN_NOW = '2025-07-13';
  const JUNE_SUM = 600;
  const JULY_SUM = 1300;
  const APR_JUN_SUM = 700;
  const YEAR_2025_SUM = 10 + 10 + 10 + 100 + JUNE_SUM + JULY_SUM;

  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(PERIOD_AVG_SCHEMA);

  const buildQuery = (query: Record<string, unknown>) => new PostgresQuery(
    { joinGraph, cubeEvaluator, compiler },
    query,
  ).buildSqlAndParams();

  const buildSql = (query: Record<string, unknown>) => buildQuery(query)[0] as string;

  const skipUnlessNative = () => !getEnv('nativeSqlPlanner');

  const skipUnlessLocalPg = () => !process.env.TEST_LOCAL;

  const expectClose = (actual: unknown, expected: number, digits = 4) => {
    expect(Number(actual)).toBeCloseTo(expected, digits);
  };

  beforeAll(() => {
    process.env.CUBEJS_TEST_NOW = FROZEN_NOW;
    return compiler.compile();
  });

  afterAll(() => {
    delete process.env.CUBEJS_TEST_NOW;
  });

  describe('SQL 分母矩阵（Tesseract）', () => {
    it('#1 calendar/day/A/month/2025-06 → 分母 30', () => {
      if (skipUnlessNative()) return;

      const sql = buildSql({
        measures: ['period_avg_facts.period_daily_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(sql).toMatch(/NULLIF/i);
      expect(sql).toMatch(/EXTRACT\s*\(\s*DAY/i);
    });

    it('#2 calendar/day/A/month/2025-07 → 分母 31（整月自然日）', () => {
      if (skipUnlessNative()) return;

      const sql = buildSql({
        measures: ['period_avg_facts.period_daily_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-07-01', '2025-07-31'],
        }],
        timezone: 'UTC',
      });

      expect(sql).toMatch(/\+\s*INTERVAL\s+'1 month'/i);
      expect(sql).not.toMatch(/LEAST/i);
      expect(sql).not.toMatch(/NOW\s*\(/i);
      expect(sql).toMatch(/EXTRACT\s*\(\s*DAY/i);
    });

    it('#3 data/day/A/month/2025-07 → 预聚合后 COUNT(日桶)', () => {
      if (skipUnlessNative()) return;

      const sql = buildSql({
        measures: ['period_avg_facts.period_daily_avg_data'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-07-01', '2025-07-31'],
        }],
        timezone: 'UTC',
      });

      expect(sql).toContain('period_avg_data_daily');
      expect(sql).toMatch(/NULLIF/i);
      expect(sql).toMatch(/COUNT\s*\(\s*"__pa_unit_/i);
      expect(sql).not.toMatch(/COUNT\s*\(\s*DISTINCT/i);
    });

    it('#4 calendar/month/B/2025-04-01~06-30 → 自然月数（AGE/EXTRACT）', () => {
      if (skipUnlessNative()) return;

      const sql = buildSql({
        measures: ['period_avg_facts.period_monthly_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          dateRange: ['2025-04-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(sql).toMatch(/AGE|EXTRACT/i);
      expect(sql).not.toMatch(/GROUP BY.*month/i);
    });

    it('#5 data/month/B/2025-04-01~06-30 → 预聚合后 COUNT(月桶)', () => {
      if (skipUnlessNative()) return;

      const sql = buildSql({
        measures: ['period_avg_facts.period_monthly_avg_data'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          dateRange: ['2025-04-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(sql).toContain('period_avg_data_daily');
      expect(sql).toMatch(/COUNT\s*\(\s*"__pa_unit_/i);
      expect(sql).not.toMatch(/COUNT\s*\(\s*DISTINCT/i);
    });

    it('#6 calendar/month/A/month/本月 → 分母 1（avg_unit=interval）', () => {
      if (skipUnlessNative()) return;

      const sql = buildSql({
        measures: ['period_avg_facts.period_monthly_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-07-01', '2025-07-31'],
        }],
        timezone: 'UTC',
      });

      expect(sql).toMatch(/NULLIF\([^,]+,\s*0\)/i);
      expect(sql).not.toMatch(/AGE/i);
    });

    it('#7 calendar/month/year interval/A/year/2025 → 按月跨度分母（整年自然月）', () => {
      if (skipUnlessNative()) return;

      const sql = buildSql({
        measures: ['period_avg_facts.period_monthly_in_year_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'year',
          dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      });

      expect(sql).toMatch(/NULLIF\([^,]+,\s*0\)/i);
      expect(sql).toMatch(/,\s*12\s*,\s*0\)|\/\s*NULLIF\(12,\s*0\)/i);
      expect(sql).not.toMatch(/LEAST/i);
      expect(sql).not.toMatch(/NOW\s*\(/i);
    });

    it('#12 year granularity rejected when interval=month（月日均）', () => {
      if (skipUnlessNative()) return;

      expect(() => buildSql({
        measures: ['period_avg_facts.period_daily_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'year',
          dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      })).toThrow(/avg_unit='day' over interval='month'/);
    });

    it('#8 sum 引用 → calendar 与 data SQL 分母不同', () => {
      if (skipUnlessNative()) return;

      const calendarSql = buildSql({
        measures: ['period_avg_facts.period_daily_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });
      const dataSql = buildSql({
        measures: ['period_avg_facts.period_daily_avg_data'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(calendarSql).not.toContain('COUNT(DISTINCT');
      expect(dataSql).toContain('period_avg_data_daily');
      expect(dataSql).toMatch(/COUNT\s*\(\s*"__pa_unit_/i);
      expect(dataSql).not.toMatch(/COUNT\s*\(\s*DISTINCT/i);
    });

    it('#8b calendar 与 data 同查 → 不走 data 预聚合 CTE', () => {
      if (skipUnlessNative()) return;

      const mixedSql = buildSql({
        measures: [
          'period_avg_facts.period_daily_avg_calendar',
          'period_avg_facts.period_daily_avg_data',
        ],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(mixedSql).not.toContain('period_avg_data_daily');
    });

    it('#9 avg 引用 → 分子为 AVG 聚合', () => {
      if (skipUnlessNative()) return;

      const fromAvgSql = buildSql({
        measures: ['period_avg_facts.period_daily_avg_from_avg'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });
      const fromSumSql = buildSql({
        measures: ['period_avg_facts.period_daily_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(fromAvgSql.toLowerCase()).toMatch(/avg\s*\(/);
      expect(fromSumSql.toLowerCase()).toMatch(/sum\s*\(/);
    });

    it('#10 week granularity → 报错', () => {
      if (skipUnlessNative()) return;

      expect(() => buildSql({
        measures: ['period_avg_facts.period_daily_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'week',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      })).toThrow(/week/i);
    });

    it('#11 day cumulative → PARTITION BY 基于 GROUP BY 日桶（非裸 stat_dt）', () => {
      if (skipUnlessNative()) return;

      const sql = buildSql({
        measures: ['period_avg_facts.period_daily_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'day',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(sql).toMatch(/OVER\s*\(/i);
      expect(sql).toMatch(/PARTITION BY\s+date_trunc\('month'/i);
      expect(sql).not.toMatch(/PARTITION BY\s+date_trunc\('month',\s*\(\s*created_at/i);
      expect(sql).not.toMatch(/PARTITION BY\s+date_trunc\('month',\s*\(\s*stat_dt/i);
    });
  });

  describe('数值执行矩阵（TEST_LOCAL=1 + Postgres）', () => {
    const runQuery = async (query: Record<string, unknown>) => {
      const [sql, params] = buildQuery(query);
      return dbRunner.testQuery([sql, params]);
    };

    it('#1 calendar/day/A/month/2025-06 → SUM÷30', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_daily_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(rows).toHaveLength(1);
      expectClose(rows[0].period_avg_facts__period_daily_avg_calendar, JUNE_SUM / 30);
    });

    it('#2 calendar/day/A/month/2025-07 → SUM÷31', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_daily_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-07-01', '2025-07-31'],
        }],
        timezone: 'UTC',
      });

      expect(rows).toHaveLength(1);
      expectClose(rows[0].period_avg_facts__period_daily_avg_calendar, JULY_SUM / 31);
    });

    it('#3 data/day/A/month/2025-07（7/11–12 无数据）→ SUM÷11', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_daily_avg_data'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-07-01', '2025-07-31'],
        }],
        timezone: 'UTC',
      });

      expect(rows).toHaveLength(1);
      expectClose(rows[0].period_avg_facts__period_daily_avg_data, JULY_SUM / 11);
    });

    it('#4 calendar/month/B/2025-04-01~06-30 → 1 行 SUM÷3', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_monthly_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          dateRange: ['2025-04-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(rows).toHaveLength(1);
      expectClose(rows[0].period_avg_facts__period_monthly_avg_calendar, APR_JUN_SUM / 3);
    });

    it('#5 data/month/B/2025-04-01~06-30（5 月无数据）→ 1 行 SUM÷2', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_monthly_avg_data'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          dateRange: ['2025-04-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(rows).toHaveLength(1);
      expectClose(rows[0].period_avg_facts__period_monthly_avg_data, APR_JUN_SUM / 2);
    });

    it('#6 calendar/month/A/month/本月 → SUM÷1', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_monthly_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-07-01', '2025-07-31'],
        }],
        timezone: 'UTC',
      });

      expect(rows).toHaveLength(1);
      expectClose(rows[0].period_avg_facts__period_monthly_avg_calendar, JULY_SUM);
    });

    it('#7 calendar/month/year interval/A/year/2025 → SUM÷12', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_monthly_in_year_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'year',
          dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      });

      expect(rows).toHaveLength(1);
      expectClose(rows[0].period_avg_facts__period_monthly_in_year_avg_calendar, YEAR_2025_SUM / 12);
    });

    it('#8 sum 引用/day/A/month/2025-06 → calendar 与 data 指标值不同', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: [
          'period_avg_facts.period_daily_avg_calendar',
          'period_avg_facts.period_daily_avg_data',
        ],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(rows).toHaveLength(1);
      const calendar = Number(rows[0].period_avg_facts__period_daily_avg_calendar);
      const data = Number(rows[0].period_avg_facts__period_daily_avg_data);
      expectClose(calendar, JUNE_SUM / 30);
      expectClose(data, JUNE_SUM / 3);
      expect(calendar).not.toBeCloseTo(data, 4);
    });

    it('#9 avg 引用/day/A/month/2025-06 → AVG÷分母 ≠ SUM÷分母', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: [
          'period_avg_facts.period_daily_avg_calendar',
          'period_avg_facts.period_daily_avg_from_avg',
        ],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(rows).toHaveLength(1);
      const fromSum = Number(rows[0].period_avg_facts__period_daily_avg_calendar);
      const fromAvg = Number(rows[0].period_avg_facts__period_daily_avg_from_avg);
      expectClose(fromSum, JUNE_SUM / 30);
      expectClose(fromAvg, (JUNE_SUM / 3) / 30);
      expect(fromSum).not.toBeCloseTo(fromAvg, 4);
    });
    it('#11 day granularity cumulative calendar/月日均 → 按日累计', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_daily_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'day',
          dateRange: ['2025-06-01', '2025-06-30'],
        }],
        timezone: 'UTC',
      });

      expect(rows).toHaveLength(3);
      const byDay = Object.fromEntries(
        rows.map((r: Record<string, unknown>) => [
          String(r.period_avg_facts__created_at).slice(0, 10),
          Number(r.period_avg_facts__period_daily_avg_calendar),
        ]),
      );
      expectClose(byDay['2025-06-01'], 100 / 1);
      expectClose(byDay['2025-06-15'], (100 + 200) / 15);
      expectClose(byDay['2025-06-30'], (100 + 200 + 300) / 30);
    });
  });
});
