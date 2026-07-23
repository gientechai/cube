import { ClickHouseQuery } from '../../src/adapter/ClickHouseQuery';
import { MysqlQuery } from '../../src/adapter/MysqlQuery';
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { prepareYamlCompiler } from './PrepareCompiler';

const multiStageTimeShiftSchema = `
cubes:
  - name: loan_debt
    sql: "SELECT '2024-01-01' AS distr_date, 100 AS loan_bal"

    dimensions:
      - name: distr_date
        sql: distr_date
        type: time

    measures:
      - name: dkye
        type: sum
        sql: loan_bal
        rolling_window:
          trailing: unbounded
      - name: dkye4
        type: number
        sql: "{dkye} - {dkye_last_month}"
        multi_stage: true
      - name: dkye_last_month
        type: number
        sql: "{dkye}"
        multi_stage: true
        time_shift:
          - time_dimension: distr_date
            interval: 1 month
            type: prior
`;

describe('ORDER BY on multi-stage JOIN (ambiguous dimension alias)', () => {
  const compilers = prepareYamlCompiler(multiStageTimeShiftSchema);

  it('MysqlQuery qualifies alias in JOIN and keeps IS NULL null ordering', async () => {
    await compilers.compiler.compile();

    const query = new MysqlQuery(compilers, {
      measures: ['loan_debt.dkye4'],
      timeDimensions: [
        {
          dimension: 'loan_debt.distr_date',
          granularity: 'day',
          dateRange: ['2026-05-03', '2026-06-03'],
        },
      ],
      timezone: 'UTC',
      order: [{ id: 'loan_debt.distr_date' }],
    });

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(
      /FROM cte_0 AS q_0 LEFT JOIN cte_2 AS q_1[\s\S]*ORDER BY q_0\.`loan_debt__distr_date_day` IS NULL DESC, q_0\.`loan_debt__distr_date_day` ASC/
    );
    expect(sql).not.toMatch(/ORDER BY 1 IS NULL/);
  });

  it('PostgresQuery uses positional ORDER BY', async () => {
    await compilers.compiler.compile();

    const query = new PostgresQuery(compilers, {
      measures: ['loan_debt.dkye4'],
      timeDimensions: [
        {
          dimension: 'loan_debt.distr_date',
          granularity: 'day',
          dateRange: ['2026-05-03', '2026-06-03'],
        },
      ],
      timezone: 'UTC',
      order: [{ id: 'loan_debt.distr_date' }],
    });

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/LEFT JOIN[\s\S]*ORDER BY 1 ASC NULLS FIRST/);
    expect(sql).not.toMatch(/ORDER BY "loan_debt__distr_date_day" ASC NULLS FIRST/);
  });

  it('ClickHouseQuery qualifies dimension ORDER BY with q_0', async () => {
    await compilers.compiler.compile();

    const query = new ClickHouseQuery(compilers, {
      measures: ['loan_debt.dkye4'],
      timeDimensions: [
        {
          dimension: 'loan_debt.distr_date',
          granularity: 'day',
          dateRange: ['2026-05-03', '2026-06-03'],
        },
      ],
      timezone: 'UTC',
      order: [{ id: 'loan_debt.distr_date' }],
    });

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(
      /FROM cte_0 AS q_0 LEFT JOIN cte_2 AS q_1[\s\S]*ORDER BY q_0\.`loan_debt__distr_date_day` ASC/
    );
  });

  it('MysqlQuery uses dimension expressions in GROUP BY for measure-filter queries', async () => {
    const { compiler, joinGraph, cubeEvaluator } = prepareYamlCompiler(`
cubes:
  - name: mymetrics_facts
    sql: "SELECT 'North' AS region, 100 AS amount UNION ALL SELECT 'South', 200 UNION ALL SELECT 'East', 75"
    dimensions:
      - name: region
        sql: region
        type: string
    measures:
      - name: filtered_ns_amount
        type: sum
        sql: amount
        filters:
          - sql: "{CUBE}.region IN ('North', 'South')"
`);

    await compiler.compile();

    const queryOptions = {
      measures: ['mymetrics_facts.filtered_ns_amount'],
      dimensions: ['mymetrics_facts.region'],
    };

    const tesseractQuery = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      { ...queryOptions, useNativeSqlPlanner: true }
    );
    const [tesseractSql] = tesseractQuery.buildSqlAndParams();
    expect(tesseractSql).not.toMatch(/GROUP BY\s+1\b/);
    expect(tesseractSql).toMatch(/GROUP BY\s+`mymetrics_facts`\.region\b/);
    expect(tesseractSql).not.toMatch(/ORDER BY\s+`mymetrics_facts__filtered_ns_amount`\s+IS NULL/);

    const jsQuery = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      { ...queryOptions, useNativeSqlPlanner: false }
    );
    const [jsSql] = jsQuery.buildSqlAndParams();
    expect(jsSql).not.toMatch(/GROUP BY\s+1\b/);
    expect(jsSql).toMatch(/GROUP BY\s+`mymetrics_facts`\.region\b/);
    expect(jsSql).toMatch(
      /ORDER BY sum\(CASE WHEN \(`mymetrics_facts`\.region IN \('North', 'South'\)\) THEN `mymetrics_facts`\.amount END\) IS NULL ASC, sum\(CASE WHEN \(`mymetrics_facts`\.region IN \('North', 'South'\)\) THEN `mymetrics_facts`\.amount END\) DESC/
    );
  });
});

describe('period_average MySQL SQL dialect', () => {
  const periodAvgSchema = `
cubes:
  - name: period_avg_facts
    sql: "SELECT TIMESTAMP '2025-06-01 10:00:00' AS stat_dt, 100 AS amount"
    dimensions:
      - name: stat_dt
        sql: stat_dt
        type: time
      - name: region
        sql: "'default'"
        type: string
    measures:
      - name: total_amount
        type: sum
        sql: amount
      - name: period_daily_avg_calendar
        type: number
        sql: "{total_amount}"
        period_average:
          avg_unit: day
          interval: month
          denominator: calendar
          time_dimension: stat_dt
      - name: period_daily_avg_data
        type: number
        sql: "{total_amount}"
        period_average:
          avg_unit: day
          interval: month
          denominator: data
          time_dimension: stat_dt
      - name: period_monthly_avg_data
        type: number
        sql: "{total_amount}"
        period_average:
          avg_unit: month
          interval: month
          denominator: data
          time_dimension: stat_dt
`;

  const compilers = prepareYamlCompiler(periodAvgSchema);
  const bucketSql = 'CAST(DATE_FORMAT(stat_dt, \'%Y-%m-01T00:00:00.000\') AS DATETIME)';

  beforeAll(async () => {
    await compilers.compiler.compile();
  });

  it('calendar/day divisor uses query time dimension expression (ONLY_FULL_GROUP_BY)', () => {
    const query = new MysqlQuery(compilers, {
      measures: ['period_avg_facts.period_daily_avg_calendar'],
      timeDimensions: [{
        dimension: 'period_avg_facts.stat_dt',
        granularity: 'month',
        dateRange: ['2025-06-01', '2025-06-30'],
      }],
      timezone: 'UTC',
    });

    const groupByExpr = query.timeDimensions[0].dimensionSql();
    const divisor = query.periodAverageDivisor('day', 'month', 'calendar', 'period_avg_facts.stat_dt', null, false);

    expect(divisor).toContain(groupByExpr);
    expect(divisor).toMatch(/MIN\(/i);
    expect(divisor).not.toMatch(/CONVERT_TZ\(stat_dt,/);
    expect(divisor).toMatch(/DAY\s*\(\s*LAST_DAY/i);
  });

  it('calendar/day divisor uses MySQL date functions', () => {
    const query = new MysqlQuery(compilers, {
      measures: ['period_avg_facts.period_daily_avg_calendar'],
      timeDimensions: [{
        dimension: 'period_avg_facts.stat_dt',
        granularity: 'month',
        dateRange: ['2025-06-01', '2025-06-30'],
      }],
      timezone: 'UTC',
    });

    const divisor = query.periodAverageDivisor('day', 'month', 'calendar', 'period_avg_facts.stat_dt', bucketSql, false);

    expect(divisor).not.toMatch(/::date/);
    expect(divisor).not.toMatch(/DATE_TRUNC/i);
    expect(divisor).toMatch(/DAY\s*\(\s*LAST_DAY/i);
  });

  it('data/day divisor uses DATE() instead of ::date cast', () => {
    const query = new MysqlQuery(compilers, {
      measures: ['period_avg_facts.period_daily_avg_data'],
      timeDimensions: [{
        dimension: 'period_avg_facts.stat_dt',
        granularity: 'month',
        dateRange: ['2025-06-01', '2025-06-30'],
      }],
      timezone: 'UTC',
    });

    const divisor = query.periodAverageDivisor('day', 'month', 'data', 'period_avg_facts.stat_dt', bucketSql, false);

    expect(divisor).not.toMatch(/::date/);
    expect(divisor).toMatch(/COUNT\(DISTINCT DATE\(/i);
  });

  it('data/month divisor uses DATE() for distinct month buckets', () => {
    const query = new MysqlQuery(compilers, {
      measures: ['period_avg_facts.period_monthly_avg_data'],
      timeDimensions: [{
        dimension: 'period_avg_facts.stat_dt',
        granularity: 'month',
        dateRange: ['2025-06-01', '2025-06-30'],
      }],
      timezone: 'UTC',
    });

    const divisor = query.periodAverageDivisor('month', 'month', 'data', 'period_avg_facts.stat_dt', bucketSql, false);

    expect(divisor).not.toMatch(/::date/);
    expect(divisor).toMatch(/COUNT\(DISTINCT DATE\(/i);
  });

  it('cumulative window uses MIN() for ONLY_FULL_GROUP_BY without nested MIN()', () => {
    const query = new MysqlQuery(compilers, {
      measures: ['period_avg_facts.period_daily_avg_calendar'],
      timeDimensions: [{
        dimension: 'period_avg_facts.stat_dt',
        granularity: 'day',
        dateRange: ['2025-06-01', '2025-06-30'],
      }],
      timezone: 'UTC',
    });

    const bucketSql = query.timeDimensions[0].dimensionSql();
    const numerator = query.periodAverageNumerator(
      'SUM(`period_avg_facts`.amount)',
      'day',
      'month',
      'period_avg_facts.stat_dt',
      bucketSql,
    );
    const divisor = query.periodAverageDivisor(
      'day',
      'month',
      'calendar',
      'period_avg_facts.stat_dt',
      bucketSql,
      false,
    );

    expect(numerator).toMatch(/OVER\s*\(/i);
    expect(numerator).toMatch(/PARTITION BY\s+MIN\s*\(/i);
    expect(numerator).toMatch(/ORDER BY\s+MIN\s*\(/i);
    expect(numerator).not.toMatch(/PARTITION BY\s+MIN\s*\(\s*MIN/i);
    expect(divisor).toMatch(/DATEDIFF/i);
    expect(divisor).toMatch(/MIN\s*\(/i);
    expect(divisor).not.toMatch(/MIN\s*\(\s*MIN/i);
  });

  it('data 分母 + 普通维度分组：外层 ORDER BY 用别名，不展开 measureSql()', () => {
    // 回归 BUG：denominator='data' 走 period_avg_data_daily 预聚合 CTE 时，外层
    // SELECT/GROUP BY 作用在 CTE 上（仅暴露别名）。MySQL 不能用 positional ORDER BY，
    // 默认按 measure 排序时若展开 measureSql() 会引用 CTE 中不存在的原始表列
    // （如 `period_avg_facts`.amount），触发 ER_BAD_FIELD_ERROR: Unknown column … in 'order clause'。
    const query = new MysqlQuery(compilers, {
      measures: ['period_avg_facts.period_daily_avg_data'],
      // 带普通维度 + 仅 dateRange（无 granularity）→ 默认按 measure DESC 排序
      dimensions: ['period_avg_facts.region'],
      timeDimensions: [{
        dimension: 'period_avg_facts.stat_dt',
        dateRange: ['2025-06-01', '2025-06-30'],
      }],
      timezone: 'UTC',
    });

    const [sql] = query.buildSqlAndParams();

    expect(sql).toContain('period_avg_data_daily');
    // 外层维度别名不得双重转义
    expect(sql).not.toMatch(/``[a-zA-Z_]/);
    // ORDER BY 必须引用 SELECT 中已投影的别名，不得展开原始表列
    expect(sql).toMatch(/ORDER BY[^]*`period_avg_facts__period_daily_avg_data`/);
    expect(sql).not.toMatch(/ORDER BY[^]*\.amount/);
  });
});
