import R from 'ramda';

import { BaseQuery } from './BaseQuery';
import { BaseFilter } from './BaseFilter';
import { UserError } from '../compiler/UserError';

const GRANULARITY_TO_INTERVAL = {
  day: (date) => `DATE_FORMAT(${date}, 'yyyy-MM-dd 00:00:00.000')`,
  week: (date) => `DATE_FORMAT(from_unixtime(unix_timestamp('1900-01-01 00:00:00') + floor((unix_timestamp(${date}) - unix_timestamp('1900-01-01 00:00:00')) / (60 * 60 * 24 * 7)) * (60 * 60 * 24 * 7)), 'yyyy-MM-dd 00:00:00.000')`,
  hour: (date) => `DATE_FORMAT(${date}, 'yyyy-MM-dd HH:00:00.000')`,
  minute: (date) => `DATE_FORMAT(${date}, 'yyyy-MM-dd HH:mm:00.000')`,
  second: (date) => `DATE_FORMAT(${date}, 'yyyy-MM-dd HH:mm:ss.000')`,
  month: (date) => `DATE_FORMAT(${date}, 'yyyy-MM-01 00:00:00.000')`,
  year: (date) => `DATE_FORMAT(${date}, 'yyyy-01-01 00:00:00.000')`,
  quarter: (date) => `concat(cast(year(${date}) as string), '-', lpad(cast((quarter(${date}) - 1) * 3 + 1 as string), 2, '0'), '-01 00:00:00.000')`
};

class HiveFilter extends BaseFilter {
  public likeIgnoreCase(column, not, param, type) {
    const p = (!type || type === 'contains' || type === 'ends') ? '%' : '';
    const s = (!type || type === 'contains' || type === 'starts') ? '%' : '';
    return `${column}${not ? ' NOT' : ''} LIKE CONCAT('${p}', ${this.allocateParam(param)}, '${s}')`;
  }
}

export class HiveQuery extends BaseQuery {
  public newFilter(filter) {
    return new HiveFilter(this as BaseQuery, filter);
  }

  public convertTz(field) {
    return `from_utc_timestamp(${field}, '${this.timezone}')`;
  }

  public timeStampCast(value) {
    return `from_utc_timestamp(replace(replace(${value}, 'T', ' '), 'Z', ''), 'UTC')`;
  }

  public dateTimeCast(value) {
    return `from_utc_timestamp(${value}, 'UTC')`; // TODO
  }

  private hiveIntervals(interval: string): Array<[number, string]> {
    const units: Record<string, number> = {
      year: 1,
      quarter: 3,
      month: 1,
      week: 7,
      day: 1,
      hour: 1,
      minute: 1,
      second: 1,
    };
    const result: Array<[number, string]> = [];
    const re = /([+-]?\d+)\s*(year|quarter|month|week|day|hour|minute|second)s?/gi;
    let match = re.exec(interval);
    while (match) {
      const amount = Number(match[1]);
      const unit = match[2].toLowerCase();
      if (unit === 'week') {
        result.push([amount * 7, 'day']);
      } else if (unit === 'quarter') {
        result.push([amount * 3, 'month']);
      } else {
        result.push([amount, unit]);
      }
      match = re.exec(interval);
    }
    if (!result.length) {
      throw new Error(`Invalid interval: ${interval}`);
    }
    return result;
  }

  private applyHiveIntervals(date: string, interval: string, invert = false) {
    return this.hiveIntervals(interval).reduce((expr, [amount, unit]) => {
      const signed = invert ? -amount : amount;
      const op = signed < 0 ? '-' : '+';
      return `(${expr} ${op} INTERVAL '${Math.abs(signed)}' ${unit})`;
    }, date);
  }

  public subtractInterval(date, interval) {
    return this.applyHiveIntervals(date, interval, true);
  }

  public addInterval(date, interval) {
    return this.applyHiveIntervals(date, interval);
  }

  public countDistinctApprox(sql: string) {
    return `approx_count_distinct(${sql})`;
  }

  public timeGroupedColumn(granularity, dimension) {
    return GRANULARITY_TO_INTERVAL[granularity](dimension);
  }

  // ==========================================================================
  // period_average 方言适配区（Hive 3.1）
  //
  // 下列方法重写 capabilities/periodAverage.js 中 PostgreSQL 风格的默认实现：
  //   - expr::date              → CAST(CAST(expr AS TIMESTAMP) AS DATE)
  //   - DATE_TRUNC('unit', x)   → trunc(x, 'unit')
  //   - AGE(a, b) + EXTRACT     → months_between(a, b) / datediff(a, b)
  //   - DATE + INTERVAL ...     → add_months(x, n) / last_day(x)
  // Hive 3.1 没有 DATE_TRUNC、AGE，也不支持 Postgres 的 `::` 转换语法。
  //
  // Hive 的桶列（timeGroupedColumn 的输出）是 DATE_FORMAT 生成的
  // 'yyyy-MM-dd HH:mm:ss.SSS' 字符串；字符串直接 CAST AS DATE 的解析规则不可靠，
  // 因此统一先 CAST AS TIMESTAMP 再 CAST AS DATE（这两种转换在 Hive 3.1 均有明确定义）。
  // ==========================================================================

  /**
   * Hive：任意日期/时间表达式 → DATE。
   * 兼容 timeGroupedColumn 的 'yyyy-MM-dd HH:mm:ss.SSS' 字符串、DATE 与 TIMESTAMP 输入。
   */
  private hiveDate(expr: string): string {
    return `CAST(CAST(${expr} AS TIMESTAMP) AS DATE)`;
  }

  /**
   * Hive：区间（季度）起点。
   * trunc 只对 'YEAR'/'MM' 有稳定语义，季度起点由「当年起点 + (quarter()-1)*3 个月」推导。
   */
  private hiveQuarterStart(bucketColumn: string): string {
    const bucketDate = this.hiveDate(bucketColumn);
    return `CAST(add_months(trunc(${bucketDate}, 'YEAR'), (quarter(${bucketDate}) - 1) * 3) AS DATE)`;
  }

  public periodAverageDateLiteral(dateStr: string): string {
    // 同 DM/Oracle：只保留日期部分，避免 '...T...Z' 后缀干扰 Hive 的字符串→日期转换。
    const dateOnly = String(dateStr).slice(0, 10);
    return `CAST('${dateOnly}' AS DATE)`;
  }

  public periodAverageNowExpr(): string {
    const frozenNow = process.env.CUBEJS_TEST_NOW;
    if (frozenNow) {
      return this.periodAverageDateLiteral(frozenNow);
    }
    // Hive 3.1 没有 (NOW() AT TIME ZONE tz)；用适配器已有的 from_utc_timestamp 做时区换算
    // （见 convertTz）。注意：这里与 timeStampCast 一样假定 Hive 会话时钟为 UTC。
    return `CAST(from_utc_timestamp(current_timestamp, '${this.timezone}') AS DATE)`;
  }

  public periodAverageToDateExpr(sql: string): string {
    return this.hiveDate(sql);
  }

  /**
   * Hive 的 GROUP BY 校验是「按列」的：select/window 里引用的列必须是分组键列，
   * 或位于聚合函数内。period_average 会继续把桶列参与日期运算（last_day/trunc 等），
   * 直接引用桶表达式会报 "Expression not in GROUP BY key"，所以与 MySQL/DM 一样用
   * MIN() 包装，让桶表达式只出现在聚合函数内（分组内取值唯一，MIN 不改变语义）。
   */
  public periodAverageGroupedBucketExpr(bucketColumn: string, _options: { aggregateOnce?: boolean } = {}) {
    if (this.ungrouped) {
      return bucketColumn;
    }
    if (/^MIN\s*\(/i.test(bucketColumn.trim())) {
      return bucketColumn;
    }
    return `MIN(${bucketColumn})`;
  }

  public periodAverageClosedFormIntervalBucketUnits(avgUnit: string, interval: string, groupedBucket: string) {
    const constant = super.periodAverageClosedFormIntervalBucketUnits(avgUnit, interval, groupedBucket);
    if (constant) {
      return constant;
    }

    if (avgUnit === 'day') {
      if (interval === 'month') {
        return this.periodAverageDaysInMonthBucket(groupedBucket);
      }
      if (interval === 'quarter') {
        return this.periodAverageDaysInQuarterBucket(groupedBucket);
      }
      if (interval === 'year') {
        return this.periodAverageDaysInYearBucket(groupedBucket);
      }
    }

    return null;
  }

  public periodAverageCumulativeCalendarUnitCount(
    avgUnit: string,
    interval: string,
    intervalStart: string,
    current: string,
  ) {
    if (avgUnit === 'day') {
      return `GREATEST(datediff(${this.hiveDate(current)}, ${this.hiveDate(intervalStart)}) + 1, 0)`;
    }
    if (avgUnit === 'month' && (interval === 'year' || interval === 'quarter' || interval === 'month')) {
      return `GREATEST(month(${this.hiveDate(current)}) - month(${this.hiveDate(intervalStart)}) + 1, 0)`;
    }
    return null;
  }

  public periodAverageDaysInMonthBucket(bucketColumn: string) {
    return `GREATEST(day(last_day(${this.hiveDate(bucketColumn)})), 0)`;
  }

  public periodAverageDaysInQuarterBucket(bucketColumn: string) {
    const quarterStart = this.hiveQuarterStart(bucketColumn);
    return `GREATEST(datediff(last_day(add_months(${quarterStart}, 2)), ${quarterStart}) + 1, 0)`;
  }

  public periodAverageDaysInYearBucket(bucketColumn: string) {
    const yearStart = `CAST(trunc(${this.hiveDate(bucketColumn)}, 'YEAR') AS DATE)`;
    return `GREATEST(datediff(last_day(add_months(${yearStart}, 11)), ${yearStart}) + 1, 0)`;
  }

  public periodAverageBucketEndExpr(granularity: string, bucketColumn: string, _bucketAlreadyAtInterval = false) {
    // 各分支都会先把桶列归一化为 DATE 再取区间末，因此与 bucketAlreadyAtInterval 无关。
    switch (granularity) {
      case 'day':
        return this.hiveDate(bucketColumn);
      case 'month':
        return `CAST(last_day(${this.hiveDate(bucketColumn)}) AS DATE)`;
      case 'quarter': {
        const quarterStart = this.hiveQuarterStart(bucketColumn);
        return `CAST(last_day(add_months(${quarterStart}, 2)) AS DATE)`;
      }
      case 'year': {
        const yearStart = `CAST(trunc(${this.hiveDate(bucketColumn)}, 'YEAR') AS DATE)`;
        return `CAST(last_day(add_months(${yearStart}, 11)) AS DATE)`;
      }
      default:
        return this.hiveDate(bucketColumn);
    }
  }

  public periodAverageIntervalStartExpr(interval: string, bucketColumn: string): string {
    switch (interval) {
      case 'day':
        return this.hiveDate(bucketColumn);
      case 'month':
        return `CAST(trunc(${this.hiveDate(bucketColumn)}, 'MM') AS DATE)`;
      case 'quarter':
        return this.hiveQuarterStart(bucketColumn);
      case 'year':
        return `CAST(trunc(${this.hiveDate(bucketColumn)}, 'YEAR') AS DATE)`;
      default:
        throw new UserError(`Unsupported period_average interval '${interval}'`);
    }
  }

  public periodAverageIntervalBucketFromAvgUnit(avgUnitBucket: string, interval: string): string {
    switch (interval) {
      case 'day':
        return avgUnitBucket;
      case 'month':
        return `CAST(trunc(${this.hiveDate(avgUnitBucket)}, 'MM') AS DATE)`;
      case 'quarter':
        return this.hiveQuarterStart(avgUnitBucket);
      case 'year':
        return `CAST(trunc(${this.hiveDate(avgUnitBucket)}, 'YEAR') AS DATE)`;
      default:
        throw new UserError(`Unsupported period_average interval '${interval}'`);
    }
  }

  public periodAverageCalendarUnitCount(unit: string, start: string, end: string): string {
    switch (unit) {
      case 'day':
        return this.daysBetweenInclusive(start, end);
      case 'month':
        return this.monthsBetweenInclusive(start, end);
      case 'quarter':
        return this.quartersBetweenInclusive(start, end);
      case 'year':
        return this.yearsBetweenInclusive(start, end);
      default:
        throw new UserError(`Unsupported period_average unit '${unit}'`);
    }
  }

  public daysBetweenInclusive(start: string, end: string): string {
    return `GREATEST(datediff(${this.hiveDate(end)}, ${this.hiveDate(start)}) + 1, 0)`;
  }

  public monthsBetweenInclusive(start: string, end: string): string {
    return `GREATEST(floor(months_between(${this.hiveDate(end)}, ${this.hiveDate(start)})) + 1, 0)`;
  }

  public quartersBetweenInclusive(start: string, end: string): string {
    return `GREATEST(floor(months_between(${this.hiveDate(end)}, ${this.hiveDate(start)}) / 3) + 1, 0)`;
  }

  public yearsBetweenInclusive(start: string, end: string): string {
    return `GREATEST(floor(months_between(${this.hiveDate(end)}, ${this.hiveDate(start)}) / 12) + 1, 0)`;
  }

  public escapeColumnName(name) {
    return `\`${name}\``;
  }

  /**
   * Tesseract uses this template object directly, so Hive identifiers must be
   * quoted with backticks here as well. Without this override the default
   * Postgres templates emit "test".column, which Hive parses as a string literal.
   */
  public sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.quotes.identifiers = '`';
    templates.quotes.escape = '\\`';
    // Hive doesn't accept Postgres-style positional GROUP BY.
    // ORDER BY keeps BaseQuery's index form (ORDER BY 1), which Hive supports.
    templates.statements.group_by_exprs = "{{ group_by | map(attribute='expr') | join(', ') }}";
    // BaseQuery uses Postgres `date_from::timestamp` and a VALUES row constructor.
    // Hive needs CAST(... AS TIMESTAMP) and a UNION ALL derived table instead.
    templates.statements.time_series_select =
      'SELECT CAST(replace(replace(dates.f, \'T\', \' \'), \'Z\', \'\') AS TIMESTAMP) AS date_from, CAST(replace(replace(dates.t, \'T\', \' \'), \'Z\', \'\') AS TIMESTAMP) AS date_to\n' +
      'FROM (\n' +
      '{% for time_item in seria %}' +
      "  SELECT '{{ time_item[0] }}' f, '{{ time_item[1] }}' t\n" +
      '{% if not loop.last %}  UNION ALL\n{% endif %}' +
      '{% endfor %}' +
      ') AS dates';
    return templates;
  }

  /**
   * Tesseract builds rolling-window bounds as two scalar subqueries:
   *   (SELECT min(`date_from`) `value` FROM time_series)
   *   (SELECT max(`date_to`) `value` FROM time_series)
   * Hive 3 rejects more than one subquery expression in WHERE. For a Hive
   * query with an explicit time series we can inline the two known bounds.
   */
  public buildSqlAndParams(exportAnnotatedSql?: boolean): [string, any[]] {
    const [sql, params] = super.buildSqlAndParams(exportAnnotatedSql);
    return [this.inlineTimeSeriesBounds(sql), params];
  }

  private inlineTimeSeriesBounds(sql: string): string {
    const minSubquery = /\(SELECT min\(`date_from`\) `value`\s+FROM time_series\)/g;
    const maxSubquery = /\(SELECT max\(`date_to`\) `value`\s+FROM time_series\)/g;
    if (!minSubquery.test(sql) || !maxSubquery.test(sql)) {
      return sql;
    }
    // Reset lastIndex after test(), since both regexes are global.
    minSubquery.lastIndex = 0;
    maxSubquery.lastIndex = 0;

    const series = [...sql.matchAll(/'([^']+)' f, '([^']+)' t/g)];
    if (series.length === 0) {
      return sql;
    }
    const castLiteral = (value: string) => `CAST(replace(replace('${value}', 'T', ' '), 'Z', '') AS TIMESTAMP)`;
    return sql
      .replace(minSubquery, castLiteral(series[0][1]))
      .replace(maxSubquery, castLiteral(series[series.length - 1][2]));
  }

  public simpleQuery() {
    // BaseQuery.simpleQuery 会把 denominator:data 的 period_average 交给
    // buildPeriodAverageDataQuery（先按 avg_unit 预聚合的 CTE）。HiveQuery 覆盖了
    // simpleQuery，必须在最前面保留同一分支：否则 data 分母会落进 hive_wrapper 结构，
    // 外层重新展开原始时间维表达式，生成 Hive 无法执行的 SQL。
    if (this.shouldUsePeriodAverageDataPreAggregatePath()) {
      return this.buildPeriodAverageDataQuery();
    }

    const ungrouped = this.evaluateSymbolSqlWithContext(
      () => `${this.commonQuery()} ${this.baseWhere(this.allFilters)}`, {
        ungroupedForWrappingGroupBy: true
      }
    );
    const select = this.evaluateSymbolSqlWithContext(
      () => this.dimensionsForSelect().map(
        d => d.aliasName()
      ).concat(this.measures.flatMap(m => m.selectColumns())).filter(s => !!s), {
        ungroupedAliases: R.fromPairs(this.forSelect().map((m: any) => [m.measure || m.dimension, m.aliasName()]))
      }
    );
    const query = `SELECT ${select} FROM (${ungrouped}) AS ${this.escapeColumnName('hive_wrapper')}
    ${this.groupByClause()}`;
    return this.baseHaving(query, this.measureFilters) + this.orderBy() + this.groupByDimensionLimit();
  }

  public seriesSql(timeDimension) {
    const values = timeDimension.timeSeries().map(
      ([from, to]) => `select '${from}' f, '${to}' t`
    ).join(' UNION ALL ');
    return `SELECT ${this.timeStampCast('dates.f')} date_from, ${this.timeStampCast('dates.t')} date_to FROM (${values}) AS dates`;
  }

  public groupByClause() {
    const dimensionsForSelect = this.dimensionsForSelect();
    const dimensionColumns =
      R.flatten(dimensionsForSelect.map(
        s => s.selectColumns() && s.aliasName()
      )).filter(s => !!s);
    return dimensionColumns.length ? ` GROUP BY ${dimensionColumns.join(', ')}` : '';
  }

  public getFieldIndex(id) {
    const idx = super.getFieldIndex(id);

    if (idx !== null) {
      return idx;
    }

    return this.escapeColumnName(this.aliasName(id));
  }

  public unixTimestampSql() {
    return 'unix_timestamp()';
  }

  public defaultRefreshKeyRenewalThreshold() {
    return 120;
  }
}
