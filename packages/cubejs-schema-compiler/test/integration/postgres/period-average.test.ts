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
        period_year_avg_data: {
          type: 'number',
          sql: \`\${total_amount}\`,
          period_average: { avg_unit: 'day', interval: 'year', denominator: 'data', time_dimension: 'created_at' },
        },
        period_daily_in_year_avg_calendar: {
          type: 'number',
          sql: \`\${total_amount}\`,
          period_average: { avg_unit: 'day', interval: 'year', denominator: 'calendar', time_dimension: 'created_at' },
        },
        period_daily_in_year_avg_data: {
          type: 'number',
          sql: \`\${total_amount}\`,
          period_average: { avg_unit: 'day', interval: 'year', denominator: 'data', time_dimension: 'created_at' },
        },
        period_daily_in_quarter_avg_calendar: {
          type: 'number',
          sql: \`\${total_amount}\`,
          period_average: { avg_unit: 'day', interval: 'quarter', denominator: 'calendar', time_dimension: 'created_at' },
        },
        period_monthly_in_year_avg_data: {
          type: 'number',
          sql: \`\${total_amount}\`,
          period_average: { avg_unit: 'month', interval: 'year', denominator: 'data', time_dimension: 'created_at' },
        },
      },
      dimensions: {
        id: { type: 'number', sql: 'id', primaryKey: true },
        created_at: { type: 'time', sql: 'created_at' },
        // 用 CASE 表达式构造一个字符串维度，模拟线上「city」等普通维度分组场景，
        // 无需改动上面 VALUES 的列结构。
        category: {
          type: 'string',
          sql: \`CASE WHEN amount >= 200 THEN 'big' ELSE 'small' END\`,
        },
        // 非 PA 时间维：与 created_at（PA time_dimension）不同的时间列，用于回归
        // 「查询按非 PA 时间维分组 + data 口径 PA measure 走 CTE 预聚合」场景。
        planned_date: { type: 'time', sql: \`(created_at + INTERVAL '1 month')\` },
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

    it('#3b data/day+year/A/带普通维度 → 外层维度不可双重转义（BUG 回归）', () => {
      if (skipUnlessNative()) return;

      // 复现 query：period_year_avg_data（denominator=data）+ 非时间维度 + this year
      // 修复前外层 SELECT 产生 ""period_avg_facts__category"" 双重引号，PG 报
      // 「长度为 0 的分隔标示符」。
      const sql = buildSql({
        measures: ['period_avg_facts.period_year_avg_data'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          dateRange: '2025 year',
        }],
        dimensions: ['period_avg_facts.category'],
        timezone: 'UTC',
      });

      expect(sql).toContain('period_avg_data_daily');
      // 外层维度 SELECT / GROUP BY 必须是单层引号标识符，禁止 ""xxx"" 双重转义
      expect(sql).not.toMatch(/""[a-zA-Z_]/);
      expect(sql).toMatch(/"period_avg_facts__category"\s+AS\s+"period_avg_facts__category"/);
      // 外层按该维度分组
      expect(sql).toMatch(/GROUP BY[^]*"period_avg_facts__category"/);
      // Postgres 走 positional ORDER BY（ORDER BY 2），引用 SELECT 第 2 列（measure 别名），
      // 天然合法、不会展开 measureSql() 引用 CTE 中不存在的原始表列。
      // （ORDER BY 展开公式的 bug 是 MySQL 专属，由 mysql-query.test.ts 覆盖。）
      expect(sql).toMatch(/ORDER BY\s+2\s+DESC/);
      expect(sql).not.toMatch(/ORDER BY[^]*\.amount/);
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

    it('#13 day/year 按 month 查 → 中间粒度累计，PARTITION BY year ORDER BY month 桶', () => {
      if (skipUnlessNative()) return;

      const sql = buildSql({
        measures: ['period_avg_facts.period_daily_in_year_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      });

      // 分子：SUM(...) OVER (PARTITION BY year ORDER BY month ROWS UNBOUNDED PRECEDING..CURRENT)
      expect(sql).toMatch(/OVER\s*\(/i);
      expect(sql).toMatch(/PARTITION BY\s+date_trunc\('year'/i);
      // 分母：年初到当月末天数（bucket end 表达式，含 + INTERVAL '1 month' - INTERVAL '1 day'）
      expect(sql).toMatch(/\+\s*INTERVAL\s*'1 month'\s*-\s*INTERVAL\s*'1 day'/i);
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

    it('#3b data/day+year/A/带普通维度 → 分组多行、SQL 不再双重转义', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      // 修复前该 query 在 PG 报「长度为 0 的分隔标示符」，根本执行不了。
      // 2025 全年按 category 分组：big(amount>=200)/small 两组，分母=各组有数据天数。
      const rows = await runQuery({
        measures: ['period_avg_facts.period_year_avg_data'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          dateRange: ['2025-01-01', '2025-12-31'],
        }],
        dimensions: ['period_avg_facts.category'],
        timezone: 'UTC',
      });

      // 两组分组
      expect(rows).toHaveLength(2);
      const byCat = Object.fromEntries(rows.map((r: any) => [r.period_avg_facts__category, r]));
      expect(byCat.big).toBeDefined();
      expect(byCat.small).toBeDefined();
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

    it('#14 day/year 按 month 查（中间粒度累计 calendar）/ 年日均 → 按月累计', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_daily_in_year_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      });

      // 2025 各月：分子为年初累计 SUM，分母为年初到当月末自然天数（calendar）。
      // 数据：1/2/3 月各 10；4 月 100；5 月无；6 月 600；7 月 1300。
      const cumSum: Record<string, number> = {
        '2025-01': 10, '2025-02': 20, '2025-03': 30, '2025-04': 130,
        '2025-05': 130, '2025-06': 730, '2025-07': 2030,
      };
      const cumDays: Record<string, number> = {
        '2025-01': 31, '2025-02': 59, '2025-03': 90, '2025-04': 120,
        '2025-05': 151, '2025-06': 181, '2025-07': 212,
      };
      const byMonth = Object.fromEntries(
        rows.map((r: Record<string, unknown>) => [
          String(r.period_avg_facts__created_at).slice(0, 7),
          Number(r.period_avg_facts__period_daily_in_year_avg_calendar),
        ]),
      );
      Object.keys(cumSum).forEach((m) => {
        expectClose(byMonth[m], cumSum[m] / cumDays[m]);
      });
    });

    it('#15 day/year 按 month 查（中间粒度累计 data）/ 年日均 → 按月累计有数据天数', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_daily_in_year_avg_data'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at',
          granularity: 'month',
          dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      });

      // 2025 各月：分子为年初累计 SUM，分母为年初到当月末「有数据天数」（data）。
      // 数据：1/2/3 月各 10（各 1 天）；4 月 100（1 天）；5 月无（不产生行）；
      // 6 月 600（3 天）；7 月 1300（7/1~7/10 + 7/13 = 11 天，7/11–12 无数据）。
      const cumSum: Record<string, number> = {
        '2025-01': 10, '2025-02': 20, '2025-03': 30, '2025-04': 130,
        '2025-06': 730, '2025-07': 2030,
      };
      const cumDataDays: Record<string, number> = {
        '2025-01': 1, '2025-02': 2, '2025-03': 3, '2025-04': 4,
        '2025-06': 7, '2025-07': 18,
      };
      const byMonth = Object.fromEntries(
        rows.map((r: Record<string, unknown>) => [
          String(r.period_avg_facts__created_at).slice(0, 7),
          Number(r.period_avg_facts__period_daily_in_year_avg_data),
        ]),
      );
      Object.keys(cumSum).forEach((m) => {
        expectClose(byMonth[m], cumSum[m] / cumDataDays[m]);
      });
    });

    // quarter 桶返回季度首日，用月份映射成 Q1/Q2/Q3 标签。
    const quarterKey = (v: unknown) => {
      const m = Number(String(v).slice(5, 7));
      return `${String(v).slice(0, 4)}-Q${Math.ceil(m / 3)}`;
    };

    it('#16 day/year 按 quarter 查（中间粒度累计 calendar）→ 按季累计', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_daily_in_year_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at', granularity: 'quarter', dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      });
      // 分子=年初累计 SUM；分母=年初到当季末自然天数（calendar）。Q4 无数据不产生行。
      const cumSum: Record<string, number> = { '2025-Q1': 30, '2025-Q2': 730, '2025-Q3': 2030 };
      const cumDays: Record<string, number> = { '2025-Q1': 90, '2025-Q2': 181, '2025-Q3': 273 };
      const byQuarter = Object.fromEntries(
        rows.map((r: Record<string, unknown>) => [
          quarterKey(r.period_avg_facts__created_at),
          Number(r.period_avg_facts__period_daily_in_year_avg_calendar),
        ]),
      );
      Object.keys(cumSum).forEach((q) => {
        expectClose(byQuarter[q], cumSum[q] / cumDays[q]);
      });
    });

    it('#17 day/year 按 quarter 查（中间粒度累计 data）→ 按季累计有数据天数', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_daily_in_year_avg_data'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at', granularity: 'quarter', dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      });
      const cumSum: Record<string, number> = { '2025-Q1': 30, '2025-Q2': 730, '2025-Q3': 2030 };
      const cumDataDays: Record<string, number> = { '2025-Q1': 3, '2025-Q2': 7, '2025-Q3': 18 };
      const byQuarter = Object.fromEntries(
        rows.map((r: Record<string, unknown>) => [
          quarterKey(r.period_avg_facts__created_at),
          Number(r.period_avg_facts__period_daily_in_year_avg_data),
        ]),
      );
      Object.keys(cumSum).forEach((q) => {
        expectClose(byQuarter[q], cumSum[q] / cumDataDays[q]);
      });
    });

    it('#18 day/quarter 按 month 查（中间粒度累计 calendar）→ 季内按月累计', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_daily_in_quarter_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at', granularity: 'month', dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      });
      // 分子=季初累计 SUM（PARTITION BY quarter，每季独立）；分母=季初到当月末自然天数（calendar）。
      // 季内天数：Q1→1月31/2月59/3月90；Q2→4月30/6月91；Q3→7月31。
      const cumSum: Record<string, number> = {
        '2025-01': 10, '2025-02': 20, '2025-03': 30,
        '2025-04': 100, '2025-06': 700, '2025-07': 1300,
      };
      const cumDays: Record<string, number> = {
        '2025-01': 31, '2025-02': 59, '2025-03': 90,
        '2025-04': 30, '2025-06': 91, '2025-07': 31,
      };
      const byMonth = Object.fromEntries(
        rows.map((r: Record<string, unknown>) => [
          String(r.period_avg_facts__created_at).slice(0, 7),
          Number(r.period_avg_facts__period_daily_in_quarter_avg_calendar),
        ]),
      );
      Object.keys(cumSum).forEach((m) => {
        expectClose(byMonth[m], cumSum[m] / cumDays[m]);
      });
    });

    it('#19 month/year 按 quarter 查（中间粒度累计 calendar）→ 按季累计月均', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_monthly_in_year_avg_calendar'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at', granularity: 'quarter', dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      });
      // 分子=年初累计 SUM；分母=年初到当季末自然月数（calendar）。
      const cumSum: Record<string, number> = { '2025-Q1': 30, '2025-Q2': 730, '2025-Q3': 2030 };
      const cumMonths: Record<string, number> = { '2025-Q1': 3, '2025-Q2': 6, '2025-Q3': 9 };
      const byQuarter = Object.fromEntries(
        rows.map((r: Record<string, unknown>) => [
          quarterKey(r.period_avg_facts__created_at),
          Number(r.period_avg_facts__period_monthly_in_year_avg_calendar),
        ]),
      );
      Object.keys(cumSum).forEach((q) => {
        expectClose(byQuarter[q], cumSum[q] / cumMonths[q]);
      });
    });

    it('#20 month/year 按 quarter 查（中间粒度累计 data）→ 按季累计有数据月数', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      const rows = await runQuery({
        measures: ['period_avg_facts.period_monthly_in_year_avg_data'],
        timeDimensions: [{
          dimension: 'period_avg_facts.created_at', granularity: 'quarter', dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      });
      // 分子=年初累计 SUM；分母=年初到当季末「有数据月数」（data）。
      // Q1: 3 个有数据月；Q2: +4/6 月（5 月无）→ 5；Q3: +7 月 → 6。
      const cumSum: Record<string, number> = { '2025-Q1': 30, '2025-Q2': 730, '2025-Q3': 2030 };
      const cumDataMonths: Record<string, number> = { '2025-Q1': 3, '2025-Q2': 5, '2025-Q3': 6 };
      const byQuarter = Object.fromEntries(
        rows.map((r: Record<string, unknown>) => [
          quarterKey(r.period_avg_facts__created_at),
          Number(r.period_avg_facts__period_monthly_in_year_avg_data),
        ]),
      );
      Object.keys(cumSum).forEach((q) => {
        expectClose(byQuarter[q], cumSum[q] / cumDataMonths[q]);
      });
    });

    it('#21 data PA measure 按「非 PA 时间维」分组（BUG 回归：CTE 未选取非 PA 时间维）', async () => {
      if (skipUnlessNative() || skipUnlessLocalPg()) return;

      // PA measure = day/month/data（time_dimension=created_at）；查询按 planned_date（非 PA 时间维）的 month 分组。
      // 回归：data 预聚合 CTE 此前跳过了所有时间维，导致外层引用 planned_date 报 Unknown column。
      const rows = await runQuery({
        measures: ['period_avg_facts.period_daily_avg_data'],
        timeDimensions: [{
          dimension: 'period_avg_facts.planned_date',
          granularity: 'month',
          dateRange: ['2025-01-01', '2025-12-31'],
        }],
        timezone: 'UTC',
      });

      // planned_date = created_at + 1 月；分母为该 planned_date 月内 created_at 的有数据天数（data）。
      // planned 2月（created 1/15）→10/1；3月（2/15）→10/1；4月（3/15）→10/1；5月（4/1）→100/1；
      // 7月（created 6/1,6/15,6/30 共 3 天）→600/3；8月（created 7/1~7/10+7/13 共 11 天）→1300/11。
      const expected: Record<string, number> = {
        '2025-02': 10, '2025-03': 10, '2025-04': 10, '2025-05': 100,
        '2025-07': 200, '2025-08': 1300 / 11,
      };
      const byMonth = Object.fromEntries(
        rows.map((r: Record<string, unknown>) => [
          String(r.period_avg_facts__planned_date).slice(0, 7),
          Number(r.period_avg_facts__period_daily_avg_data),
        ]),
      );
      Object.keys(expected).forEach((m) => {
        expectClose(byMonth[m], expected[m]);
      });
    });
  });
});
