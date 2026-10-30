import { HiveQuery } from '../../src/adapter/HiveQuery';
import { prepareYamlCompiler } from './PrepareCompiler';

describe('HiveQuery', () => {
  const compilers = prepareYamlCompiler(`
cubes:
  - name: test
    sql: "SELECT 'east' AS region, 1 AS id"
    dimensions:
      - name: id
        sql: id
        type: number
      - name: region
        sql: region
        type: string
`);

  beforeAll(async () => {
    await compilers.compiler.compile();
  });

  it('keeps the native planner enabled when requested', () => {
    const query = new HiveQuery(
      {
        joinGraph: compilers.joinGraph,
        cubeEvaluator: compilers.cubeEvaluator,
        compiler: compilers.compiler,
      },
      { dimensions: ['test.region'], timezone: 'UTC', useNativeSqlPlanner: true },
    );

    expect(query.useNativeSqlPlanner).toBe(true);
  });

  it('uses Hive backtick quoting for Tesseract templates', () => {
    const query = new HiveQuery(
      {
        joinGraph: compilers.joinGraph,
        cubeEvaluator: compilers.cubeEvaluator,
        compiler: compilers.compiler,
      },
      { dimensions: ['test.region'], timezone: 'UTC' },
    );

    const templates = query.sqlTemplates();
    expect(templates.quotes.identifiers).toBe('`');
    expect(templates.quotes.escape).toBe('\\`');
    expect(templates.statements.group_by_exprs).toContain("attribute='expr'");
    expect(templates.statements.group_by_exprs).not.toContain("attribute='index'");
    // Keep BaseQuery's ORDER BY index form; Hive JDBC enables position alias per connection.
    expect(templates.expressions.order_by).toContain('index');
    // BaseQuery's default time_series_select uses Postgres `::timestamp` and VALUES.
    expect(templates.statements.time_series_select).toContain("CAST(replace(replace(dates.f, 'T', ' '), 'Z', '') AS TIMESTAMP)");
    expect(templates.statements.time_series_select).not.toContain('::timestamp');
    expect(templates.statements.time_series_select).not.toContain('VALUES');
  });

  it('generates backtick-quoted identifiers in classic Hive SQL', () => {
    const query = new HiveQuery(
      {
        joinGraph: compilers.joinGraph,
        cubeEvaluator: compilers.cubeEvaluator,
        compiler: compilers.compiler,
      },
      { dimensions: ['test.region'], timezone: 'UTC' },
    );

    const [sql] = query.buildSqlAndParams();
    expect(sql).toContain('`test`.region');
    expect(sql).not.toContain('"test".region');
  });
});

describe('HiveQuery period_average dialect', () => {
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
      - name: period_monthly_in_year_avg_calendar
        type: number
        sql: "{total_amount}"
        period_average:
          avg_unit: month
          interval: year
          denominator: calendar
          time_dimension: stat_dt
`;

  const compilers = prepareYamlCompiler(periodAvgSchema);
  const timeDimensionPath = 'period_avg_facts.stat_dt';
  const monthTimeDimension = {
    dimension: timeDimensionPath,
    granularity: 'month',
    dateRange: ['2025-06-01', '2025-06-30'],
  };

  const newQuery = (options: Record<string, any> = {}) => new HiveQuery(compilers, {
    timezone: 'UTC',
    ...options,
  });

  beforeAll(async () => {
    await compilers.compiler.compile();
  });

  it('emits Hive date literals, current date and DATE casts', () => {
    const query = newQuery({ measures: ['period_avg_facts.period_daily_avg_calendar'] });

    expect(query.periodAverageDateLiteral('2025-06-01')).toBe("CAST('2025-06-01' AS DATE)");
    expect(query.periodAverageDateLiteral('2025-06-01T00:00:00.000Z')).toBe("CAST('2025-06-01' AS DATE)");
    expect(query.periodAverageToDateExpr('x.bucket')).toBe('CAST(CAST(x.bucket AS TIMESTAMP) AS DATE)');
    expect(query.periodAverageToDateExpr('x.bucket')).not.toContain('::');

    const frozenNow = process.env.CUBEJS_TEST_NOW;
    process.env.CUBEJS_TEST_NOW = '2025-07-13';
    try {
      expect(query.periodAverageNowExpr()).toBe("CAST('2025-07-13' AS DATE)");
    } finally {
      if (frozenNow === undefined) {
        delete process.env.CUBEJS_TEST_NOW;
      } else {
        process.env.CUBEJS_TEST_NOW = frozenNow;
      }
    }

    if (frozenNow === undefined) {
      expect(query.periodAverageNowExpr()).toBe("CAST(from_utc_timestamp(current_timestamp, 'UTC') AS DATE)");
      expect(query.periodAverageNowExpr()).not.toMatch(/NOW\(\)/i);
    }
  });

  it('derives interval buckets with trunc/add_months/last_day instead of DATE_TRUNC', () => {
    const query = newQuery({
      measures: ['period_avg_facts.period_daily_avg_calendar'],
      timeDimensions: [monthTimeDimension],
    });

    expect(query.periodAverageGroupedBucketExpr('x.bucket')).toBe('MIN(x.bucket)');
    // 已聚合的桶列不应再套一层 MIN（避免 MIN(MIN(...))）
    expect(query.periodAverageGroupedBucketExpr('MIN(x.bucket)')).toBe('MIN(x.bucket)');

    const intervalStartExpressions = [
      query.periodAverageIntervalStartExpr('month', 'x.bucket'),
      query.periodAverageIntervalStartExpr('quarter', 'x.bucket'),
      query.periodAverageIntervalStartExpr('year', 'x.bucket'),
      query.periodAverageIntervalBucketFromAvgUnit('x.bucket', 'day'),
      query.periodAverageIntervalBucketFromAvgUnit('x.bucket', 'month'),
      query.periodAverageIntervalBucketFromAvgUnit('x.bucket', 'quarter'),
      query.periodAverageIntervalBucketFromAvgUnit('x.bucket', 'year'),
      query.periodAverageBucketEndExpr('month', 'x.bucket'),
      query.periodAverageBucketEndExpr('month', 'x.bucket', true),
      query.periodAverageBucketEndExpr('quarter', 'x.bucket'),
      query.periodAverageBucketEndExpr('year', 'x.bucket'),
    ];

    expect(query.periodAverageIntervalStartExpr('month', 'x.bucket')).toContain("'MM'");
    expect(query.periodAverageIntervalStartExpr('quarter', 'x.bucket')).toContain('add_months');
    expect(query.periodAverageIntervalStartExpr('quarter', 'x.bucket')).toContain('quarter(');
    expect(query.periodAverageIntervalStartExpr('year', 'x.bucket')).toContain("'YEAR'");
    expect(query.periodAverageBucketEndExpr('month', 'x.bucket')).toContain('last_day');
    expect(query.periodAverageBucketEndExpr('quarter', 'x.bucket')).toContain('add_months');
    expect(query.periodAverageBucketEndExpr('year', 'x.bucket')).toContain('11');

    intervalStartExpressions.forEach((fragment) => {
      expect(fragment).not.toContain('::');
      expect(fragment).not.toMatch(/DATE_TRUNC/i);
      expect(fragment).not.toMatch(/AGE\s*\(/i);
    });

    expect(() => query.periodAverageIntervalStartExpr('week', 'x.bucket'))
      .toThrow(/Unsupported period_average interval 'week'/);
    expect(() => query.periodAverageIntervalBucketFromAvgUnit('x.bucket', 'hour'))
      .toThrow(/Unsupported period_average interval 'hour'/);
  });

  it('interval-bucket calendar divisor uses Hive day/last_day functions', () => {
    const query = newQuery({
      measures: ['period_avg_facts.period_daily_avg_calendar'],
      timeDimensions: [monthTimeDimension],
    });
    const bucketSql = query.timeDimensions[0].dimensionSql();

    const divisor = query.periodAverageDivisor('day', 'month', 'calendar', timeDimensionPath, bucketSql, false);

    expect(divisor).toContain('day(last_day(');
    expect(divisor).toContain('MIN(');
    expect(divisor).not.toContain('::');
    expect(divisor).not.toMatch(/DATE_TRUNC/i);
    expect(divisor).not.toMatch(/AGE\s*\(/i);
    expect(divisor).not.toMatch(/EXTRACT\s*\(/i);
  });

  it('closed-form and cumulative calendar counts use Hive date arithmetic', () => {
    const query = newQuery({ measures: ['period_avg_facts.period_daily_avg_calendar'] });

    expect(query.periodAverageClosedFormIntervalBucketUnits('day', 'month', 'MIN(x.bucket)')).toContain('day(last_day(');
    expect(query.periodAverageClosedFormIntervalBucketUnits('day', 'quarter', 'MIN(x.bucket)')).toContain('add_months');
    expect(query.periodAverageClosedFormIntervalBucketUnits('day', 'year', 'MIN(x.bucket)')).toContain("'YEAR'");
    // 常数快路径仍走 super
    expect(query.periodAverageClosedFormIntervalBucketUnits('month', 'quarter', 'MIN(x.bucket)')).toBe('3');
    expect(query.periodAverageClosedFormIntervalBucketUnits('month', 'year', 'MIN(x.bucket)')).toBe('12');
    expect(query.periodAverageClosedFormIntervalBucketUnits('quarter', 'year', 'MIN(x.bucket)')).toBe('4');

    expect(query.periodAverageCumulativeCalendarUnitCount('day', 'month', 'x.start', 'x.cur')).toContain('datediff(');
    expect(query.periodAverageCumulativeCalendarUnitCount('month', 'year', 'x.start', 'x.cur')).toContain('month(');

    expect(query.periodAverageCalendarUnitCount('day', 'x.s', 'x.e')).toContain('datediff(');
    expect(query.periodAverageCalendarUnitCount('month', 'x.s', 'x.e')).toContain('months_between(');
    expect(query.periodAverageCalendarUnitCount('quarter', 'x.s', 'x.e')).toContain(') / 3');
    expect(query.periodAverageCalendarUnitCount('year', 'x.s', 'x.e')).toContain(') / 12');

    expect(() => query.periodAverageCalendarUnitCount('week', 'x.s', 'x.e'))
      .toThrow(/Unsupported period_average unit 'week'/);
  });

  it('cumulative numerator wraps grouped bucket expressions in MIN()', () => {
    const query = newQuery({
      measures: ['period_avg_facts.period_daily_avg_calendar'],
      timeDimensions: [{ ...monthTimeDimension, granularity: 'day' }],
    });
    const bucketSql = query.timeDimensions[0].dimensionSql();

    const numerator = query.periodAverageNumerator(
      'SUM(`period_avg_facts`.amount)',
      'day',
      'month',
      timeDimensionPath,
      bucketSql,
    );
    const divisor = query.periodAverageDivisor('day', 'month', 'calendar', timeDimensionPath, bucketSql, false);

    expect(numerator).toContain('OVER (');
    expect(numerator).toContain('PARTITION BY MIN(');
    expect(numerator).toContain('ORDER BY MIN(');
    expect(numerator).toContain("'MM'");
    expect(numerator).not.toMatch(/MIN\s*\(\s*MIN/i);
    expect(divisor).toContain('datediff(');
    expect(divisor).toContain('MIN(');
    expect(divisor).not.toMatch(/MIN\s*\(\s*MIN/i);

    [numerator, divisor].forEach((fragment) => {
      expect(fragment).not.toContain('::');
      expect(fragment).not.toMatch(/DATE_TRUNC/i);
      expect(fragment).not.toMatch(/AGE\s*\(/i);
    });
  });

  it('month/year cumulative divisor counts months without AGE/EXTRACT', () => {
    const query = newQuery({
      measures: ['period_avg_facts.period_monthly_in_year_avg_calendar'],
      timeDimensions: [monthTimeDimension],
    });
    const bucketSql = query.timeDimensions[0].dimensionSql();

    const divisor = query.periodAverageDivisor('month', 'year', 'calendar', timeDimensionPath, bucketSql, false);

    expect(divisor).toContain('month(');
    expect(divisor).not.toMatch(/EXTRACT\s*\(/i);
    expect(divisor).not.toMatch(/AGE\s*\(/i);
    expect(divisor).not.toContain('::');
    expect(divisor).not.toMatch(/DATE_TRUNC/i);
  });

  it('generates Hive 3.1 calendar period_average SQL with the native planner', () => {
    const query = newQuery({
      useNativeSqlPlanner: true,
      measures: ['period_avg_facts.period_daily_avg_calendar'],
      timeDimensions: [monthTimeDimension],
    });

    const [sql] = query.buildSqlAndParams();

    expect(sql).toContain('day(last_day(');
    expect(sql).toContain('`period_avg_facts`.stat_dt');
    expect(sql).not.toContain('::');
    expect(sql).not.toMatch(/DATE_TRUNC/i);
    expect(sql).not.toMatch(/AGE\s*\(/i);
    expect(sql).not.toMatch(/EXTRACT\s*\(/i);
    expect(sql).not.toContain('"period_avg_facts"');

    const rangeQuery = newQuery({
      useNativeSqlPlanner: true,
      measures: ['period_avg_facts.period_daily_avg_calendar'],
      timeDimensions: [{ dimension: timeDimensionPath, dateRange: ['2025-06-01', '2025-06-30'] }],
    });
    const [rangeSql] = rangeQuery.buildSqlAndParams();

    expect(rangeSql).toContain('datediff(');
    expect(rangeSql).toContain("CAST('2025-06-30' AS DATE)");
    expect(rangeSql).not.toContain('::');
    expect(rangeSql).not.toMatch(/AGE\s*\(/i);
  });

  it('routes denominator:data through the avg_unit pre-aggregation CTE', () => {
    const query = newQuery({
      measures: ['period_avg_facts.period_daily_avg_data'],
      timeDimensions: [monthTimeDimension],
    });

    const [sql] = query.buildSqlAndParams();

    expect(sql).toContain('period_avg_data_daily');
    expect(sql).toContain('`__pa_unit_period_avg_facts__period_daily_avg_data`');
    expect(sql).toContain('COUNT(`__pa_unit_period_avg_facts__period_daily_avg_data`)');
    expect(sql).toContain('CAST(CAST(DATE_FORMAT(');
    // denominator:data 不能再落到 hive_wrapper 外层结构（外层引用不到原始时间维列）
    expect(sql).not.toContain('hive_wrapper');
    expect(sql).not.toContain('::');
    expect(sql).not.toMatch(/DATE_TRUNC/i);
    expect(sql).not.toMatch(/AGE\s*\(/i);
  });
});
