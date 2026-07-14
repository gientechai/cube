import { parseSqlInterval } from '@cubejs-backend/shared';
import { BaseQuery } from './BaseQuery';
import { BaseFilter } from './BaseFilter';
import { UserError } from '../compiler/UserError';
import type { BaseDimension } from './BaseDimension';

const GRANULARITY_VALUE = {
  day: 'DD',
  week: 'IW',
  hour: 'HH24',
  minute: 'mm',
  second: 'ss',
  month: 'MM',
  quarter: 'Q',
  year: 'YYYY'
};

/**
 * Splits `WITH cte AS (...), ... SELECT ...` into the WITH prefix and main SELECT.
 * Oracle rejects WITH inside subquery parentheses (ORA-32034 / ORA-00911).
 */
function splitLeadingWithClause(sql: string): { withClause: string; mainSql: string } | null {
  const trimmed = sql.trim();
  if (!/^WITH\s+/i.test(trimmed)) {
    return null;
  }

  let depth = 0;
  let inSingleQuote = false;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];

    if (inSingleQuote) {
      if (c === '\'' && trimmed[i + 1] === '\'') {
        i += 1;
      } else if (c === '\'') {
        inSingleQuote = false;
      }
      continue;
    }

    if (c === '\'') {
      inSingleQuote = true;
      continue;
    }

    if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
    } else if (depth === 0 && /^SELECT\b/i.test(trimmed.slice(i))) {
      return {
        withClause: trimmed.slice(0, i).trim(),
        mainSql: trimmed.slice(i).trim(),
      };
    }
  }

  return null;
}

class OracleFilter extends BaseFilter {
  public castParameter() {
    return ':"?"';
  }

  /**
   * "ILIKE" is not supported
   */
  public likeIgnoreCase(column, not, param, type) {
    const p = (!type || type === 'contains' || type === 'ends') ? '\'%\' || ' : '';
    const s = (!type || type === 'contains' || type === 'starts') ? ' || \'%\'' : '';
    return `${column}${not ? ' NOT' : ''} LIKE ${p}${this.allocateParam(param)}${s}`;
  }
}

export class OracleQuery extends BaseQuery {

  /**
   * "LIMIT" on Oracle is illegal
   * TODO replace with limitOffsetClause override
   */
  public groupByDimensionLimit() {
    const limitClause = this.rowLimit === null ? '' : ` FETCH NEXT ${this.rowLimit && parseInt(this.rowLimit, 10) || 10000} ROWS ONLY`;
    const offsetClause = this.offset ? ` OFFSET ${parseInt(this.offset, 10)} ROWS` : '';
    return `${offsetClause}${limitClause}`;
  }

  /**
   * Hoist leading WITH when wrapping semi-additive CTEs as q_0 — Oracle forbids WITH in parentheses.
   */
  public outerMeasuresJoinFullKeyQueryAggregate(innerMembers, outerMembers, toJoin, joinOptions = {}) {
    if (toJoin.length === 1) {
      const split = splitLeadingWithClause(toJoin[0]);
      if (split) {
        const inner = super.outerMeasuresJoinFullKeyQueryAggregate(
          innerMembers,
          outerMembers,
          [split.mainSql],
          joinOptions,
        );
        return `${split.withClause}\n${inner}`;
      }
    }
    return super.outerMeasuresJoinFullKeyQueryAggregate(innerMembers, outerMembers, toJoin, joinOptions);
  }

  /**
   * "AS" for table aliasing on Oracle it's illegal
   */
  public get asSyntaxTable() {
    return '';
  }

  public get asSyntaxJoin() {
    return this.asSyntaxTable;
  }

  /**
   * Oracle doesn't support group by index,
   * using forSelect dimensions for grouping
   */
  public groupByClause() {
    // Only include dimensions that have select columns
    // Time dimensions without granularity return null from selectColumns()
    const dimensions = this.forSelect().filter((item: any) => (
      !!item.dimension && item.selectColumns && item.selectColumns()
    )) as BaseDimension[];
    if (!dimensions.length) {
      return '';
    }

    return ` GROUP BY ${dimensions.map(item => item.dimensionSql()).join(', ')}`;
  }

  public convertTz(field) {
    /**
     * TODO: add offset timezone
     */
    return field;
  }

  private oracleBindExpr(value: string | number): string {
    const v = String(value);
    // 已是完整 Oracle 绑定名
    if (v.startsWith(':"')) {
      return v;
    }
    // Tesseract 内部占位 $_N_$，最终由 params.param 模板统一替换为 :"?'
    if (/^\$_\d+_\$$/.test(v)) {
      return v;
    }
    return `:"${v}"`;
  }

  public dateTimeCast(value) {
    // Use timezone-aware parsing for ISO 8601 with milliseconds and trailing 'Z', then cast to DATE
    // to preserve index-friendly comparisons against DATE columns.
    return `CAST(TO_TIMESTAMP_TZ(${this.oracleBindExpr(value)}, 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"') AS DATE)`;
  }

  public timeStampCast(value) {
    // Return timezone-aware timestamp for TIMESTAMP comparisons
    return `TO_TIMESTAMP_TZ(${this.oracleBindExpr(value)}, 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"')`;
  }

  public timeStampParam(timeDimension) {
    return timeDimension.dateFieldType() === 'string' ? ':"?"' : this.timeStampCast('?');
  }

  public timeGroupedColumn(granularity, dimension) {
    if (!granularity) {
      return dimension;
    }
    return `TRUNC(${dimension}, '${GRANULARITY_VALUE[granularity]}')`;
  }

  /**
   * Oracle uses ADD_MONTHS for year/month/quarter intervals
   * and NUMTODSINTERVAL for day/hour/minute/second intervals
   */
  public addInterval(date: string, interval: string): string {
    const intervalParsed = parseSqlInterval(interval);
    let res = date;

    // Handle year/month/quarter using ADD_MONTHS
    let totalMonths = 0;
    if (intervalParsed.year) {
      totalMonths += intervalParsed.year * 12;
    }
    if (intervalParsed.quarter) {
      totalMonths += intervalParsed.quarter * 3;
    }
    if (intervalParsed.month) {
      totalMonths += intervalParsed.month;
    }

    if (totalMonths !== 0) {
      res = `ADD_MONTHS(${res}, ${totalMonths})`;
    }

    // Handle day/hour/minute/second using NUMTODSINTERVAL
    if (intervalParsed.day) {
      res = `${res} + NUMTODSINTERVAL(${intervalParsed.day}, 'DAY')`;
    }
    if (intervalParsed.hour) {
      res = `${res} + NUMTODSINTERVAL(${intervalParsed.hour}, 'HOUR')`;
    }
    if (intervalParsed.minute) {
      res = `${res} + NUMTODSINTERVAL(${intervalParsed.minute}, 'MINUTE')`;
    }
    if (intervalParsed.second) {
      res = `${res} + NUMTODSINTERVAL(${intervalParsed.second}, 'SECOND')`;
    }

    return res;
  }

  /**
   * Oracle subtraction uses ADD_MONTHS with negative values
   * and subtracts NUMTODSINTERVAL for time units
   */
  public subtractInterval(date: string, interval: string): string {
    const intervalParsed = parseSqlInterval(interval);
    let res = date;

    // Handle year/month/quarter using ADD_MONTHS with negative values
    let totalMonths = 0;
    if (intervalParsed.year) {
      totalMonths += intervalParsed.year * 12;
    }
    if (intervalParsed.quarter) {
      totalMonths += intervalParsed.quarter * 3;
    }
    if (intervalParsed.month) {
      totalMonths += intervalParsed.month;
    }

    if (totalMonths !== 0) {
      res = `ADD_MONTHS(${res}, -${totalMonths})`;
    }

    // Handle day/hour/minute/second using NUMTODSINTERVAL with subtraction
    if (intervalParsed.day) {
      res = `${res} - NUMTODSINTERVAL(${intervalParsed.day}, 'DAY')`;
    }
    if (intervalParsed.hour) {
      res = `${res} - NUMTODSINTERVAL(${intervalParsed.hour}, 'HOUR')`;
    }
    if (intervalParsed.minute) {
      res = `${res} - NUMTODSINTERVAL(${intervalParsed.minute}, 'MINUTE')`;
    }
    if (intervalParsed.second) {
      res = `${res} - NUMTODSINTERVAL(${intervalParsed.second}, 'SECOND')`;
    }

    return res;
  }

  public newFilter(filter) {
    return new OracleFilter(this, filter);
  }

  /**
   * Tesseract 模板定制（同 DmQuery 思路）：Oracle 不支持表/子查询别名的 AS、GROUP BY 序号、VALUES、LIMIT。
   */
  public sqlTemplates() {
    const templates = super.sqlTemplates();

    templates.statements.group_by_exprs = '{{ group_by | map(attribute=\'expr\') | join(\', \') }}';
    templates.expressions.order_by = '{{ expr }} {% if asc %}ASC NULLS FIRST{% else %}DESC NULLS LAST{% endif %}';
    templates.expressions.query_aliased = '{{ query }} {{ quoted_alias }}';
    templates.statements.select = '{% if ctes %} WITH \n' +
      '{{ ctes | join(\',\n\') }}\n' +
      '{% endif %}' +
      'SELECT {% if distinct %}DISTINCT {% endif %}' +
      '{{ select_concat | map(attribute=\'aliased\') | join(\', \') }} {% if from %}\n' +
      'FROM (\n' +
      '{{ from | indent(2, true) }}\n' +
      ') {{ from_alias }}{% elif from_prepared %}\n' +
      'FROM {{ from_prepared }}' +
      '{% endif %}' +
      '{% for join in joins %}\n{{ join }}{% endfor %}' +
      '{% if filter %}\nWHERE {{ filter }}{% endif %}' +
      '{% if group_by %}\nGROUP BY {{ group_by }}{% endif %}' +
      '{% if having %}\nHAVING {{ having }}{% endif %}' +
      '{% if order_by %}\nORDER BY {{ order_by | map(attribute=\'expr\') | join(\', \') }}' +
      '{% if limit is not none or offset is not none %}\nOFFSET {% if offset is not none %}{{ offset }}{% else %}0{% endif %} ROWS' +
      '{% if limit is not none %}\nFETCH NEXT {{ limit }} ROWS ONLY{% endif %}{% endif %}' +
      '{% else %}{% if limit is not none %}\nFETCH FIRST {{ limit }} ROWS ONLY{% endif %}{% endif %}';
    templates.statements.calc_groups_join = templates.statements.calc_groups_join.replace(
      ') AS {{ group.alias }}',
      ') {{ group.alias }}',
    );
    templates.statements.time_series_select = '{% for time_item in seria %}'
      + 'SELECT CAST(TO_TIMESTAMP_TZ(\'{{ time_item[0] }}\', \'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"\') AS DATE) AS "date_from", '
      + 'CAST(TO_TIMESTAMP_TZ(\'{{ time_item[1] }}\', \'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"\') AS DATE) AS "date_to" FROM DUAL'
      + '{% if not loop.last %} UNION ALL {% endif %}'
      + '{% endfor %}';
    templates.tesseract.ilike = '{{ expr }} {% if negated %}NOT {% endif %}LIKE {{ pattern }}';
    // Tesseract 默认 `?` 占位符；Oracle/oracledb 需要与 JS 路径一致的命名绑定
    templates.params.param = ':"?"';

    return templates;
  }

  public unixTimestampSql() {
    // eslint-disable-next-line quotes
    return `((cast (systimestamp at time zone 'UTC' as date) - date '1970-01-01') * 86400)`;
  }

  public preAggregationTableName(cube, preAggregationName, skipSchema) {
    const name = super.preAggregationTableName(cube, preAggregationName, skipSchema);
    if (name.length > 128) {
      throw new UserError(`Oracle can not work with table names that longer than 64 symbols. Consider using the 'sqlAlias' attribute in your cube and in your pre-aggregation definition for ${name}.`);
    }
    return name;
  }

  /**
   * 重写：Oracle 不支持 FILTER 语法，使用 CASE WHEN 替代
   *
   * @param {string} aggregateExpr - 聚合表达式，如 'SUM(balance)'
   * @param {string} condition - 过滤条件，如 'balance = max_balance_window'
   * @returns {string}
   */
  semiAdditiveAggregateFilter(aggregateExpr, condition) {
    // 解析聚合表达式: 'SUM(balance)' -> { func: 'SUM', arg: 'balance' }
    const match = aggregateExpr.match(/(\w+)\(([^)]+)\)/);

    if (!match) {
      throw new Error(
        `Invalid aggregate expression for semi-additive measure: ${aggregateExpr}`
      );
    }

    const [, func, arg] = match;

    // SUM(balance) FILTER (WHERE balance = max_window)
    // -> SUM(CASE WHEN balance = max_window THEN balance ELSE 0 END)
    return `${func}(CASE WHEN ${condition} THEN ${arg} ELSE 0 END)`;
  }

  /**
   * 重写：Oracle 不支持 FILTER 语法
   *
   * @returns {boolean}
   */
  supportsFilterClause() {
    return false;
  }

  // ==========================================================================
  // period_average 方言适配区（Oracle）
  //
  // 下面方法均是对 BaseQuery 中 PostgreSQL 风格默认实现的重写，将日期/时间函数
  // 替换为 Oracle 语法。适配新数据库时，参照本区块重写下列方法（详见 BaseQuery
  // 中各方法的 @dialect 注释）：
  //   - periodAverageDateLiteral         日期字面量
  //   - periodAverageNowExpr             当前日期（注意：用 SYSDATE，DB 服务器时区）
  //   - periodAverageToDateExpr          转 DATE 类型
  //   - periodAverageGroupedBucketExpr   窗口列 MIN 包装
  //   - periodAverageClosedFormIntervalBucketUnits  整区间 calendar 快路径（先 super）
  //   - periodAverageCumulativeCalendarUnitCount    累计 calendar 快路径（先 super）
  //   - periodAverageDaysIn{Month,Quarter,Year}Bucket  桶内天数
  //   - periodAverageBucketEndExpr       区间终点
  //   - periodAverageIntervalStartExpr   区间起点
  //   - periodAverageIntervalBucketFromAvgUnit  从 avg_unit 列推区间桶
  //   - {days,months,quarters,years}BetweenInclusive  间隔计数
  //   - ownedCubeQualifiedColumnReplacements  标识符引号规则（本库：双引号 + 无引号大小写不敏感）
  // ==========================================================================

  /**
   * Oracle：`"cube".COL`（引号保留大小写）与无引号 cube 名（大小写不敏感）。
   */
  periodAverageDateLiteral(dateStr: string): string {
    const dateOnly = String(dateStr).slice(0, 10);
    return `DATE '${dateOnly}'`;
  }

  periodAverageNowExpr(): string {
    const frozenNow = process.env.CUBEJS_TEST_NOW;
    if (frozenNow) {
      return this.periodAverageDateLiteral(frozenNow);
    }
    return 'TRUNC(SYSDATE)';
  }

  periodAverageToDateExpr(sql: string): string {
    return `CAST(${sql} AS DATE)`;
  }

  periodAverageGroupedBucketExpr(bucketColumn: string, options: { aggregateOnce?: boolean } = {}) {
    if (this.ungrouped) {
      return bucketColumn;
    }
    const trimmed = bucketColumn.trim();
    if (/^MIN\s*\(/i.test(trimmed)) {
      return bucketColumn;
    }
    return `MIN(${bucketColumn})`;
  }

  periodAverageClosedFormIntervalBucketUnits(avgUnit: string, interval: string, groupedBucket: string) {
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

  periodAverageCumulativeCalendarUnitCount(
    avgUnit: string,
    interval: string,
    intervalStart: string,
    current: string,
  ) {
    if (avgUnit === 'day') {
      return `GREATEST((CAST(${current} AS DATE) - CAST(${intervalStart} AS DATE) + 1), 0)`;
    }
    if (avgUnit === 'month' && (interval === 'year' || interval === 'quarter' || interval === 'month')) {
      return `GREATEST(EXTRACT(MONTH FROM CAST(${current} AS DATE)) - EXTRACT(MONTH FROM CAST(${intervalStart} AS DATE)) + 1, 0)`;
    }
    return null;
  }

  periodAverageDaysInMonthBucket(bucketColumn: string) {
    return `GREATEST(EXTRACT(DAY FROM LAST_DAY(CAST(${bucketColumn} AS DATE))), 0)`;
  }

  periodAverageDaysInQuarterBucket(bucketColumn: string) {
    const quarterStart = `CAST(TRUNC(CAST(${bucketColumn} AS DATE), 'Q') AS DATE)`;
    const quarterEnd = `LAST_DAY(ADD_MONTHS(${quarterStart}, 2))`;
    return `GREATEST((${quarterEnd} - ${quarterStart} + 1), 0)`;
  }

  periodAverageDaysInYearBucket(bucketColumn: string) {
    const yearStart = `CAST(TRUNC(CAST(${bucketColumn} AS DATE), 'YYYY') AS DATE)`;
    const yearEnd = `LAST_DAY(ADD_MONTHS(${yearStart}, 11))`;
    return `GREATEST((${yearEnd} - ${yearStart} + 1), 0)`;
  }

  periodAverageBucketEndExpr(granularity: string, bucketColumn: string, bucketAlreadyAtInterval = false) {
    const asDate = `CAST(${bucketColumn} AS DATE)`;
    if (bucketAlreadyAtInterval) {
      switch (granularity) {
        case 'day':
          return this.periodAverageToDateExpr(bucketColumn);
        case 'month':
          return `LAST_DAY(${asDate})`;
        case 'quarter':
          return `LAST_DAY(ADD_MONTHS(CAST(TRUNC(${asDate}, 'Q') AS DATE), 2))`;
        case 'year':
          return `LAST_DAY(ADD_MONTHS(CAST(TRUNC(${asDate}, 'YYYY') AS DATE), 11))`;
        default:
          return this.periodAverageToDateExpr(bucketColumn);
      }
    }

    switch (granularity) {
      case 'day':
        return this.periodAverageToDateExpr(bucketColumn);
      case 'month':
        return `LAST_DAY(CAST(TRUNC(${asDate}, 'MM') AS DATE))`;
      case 'quarter':
        return `LAST_DAY(ADD_MONTHS(CAST(TRUNC(${asDate}, 'Q') AS DATE), 2))`;
      case 'year':
        return `LAST_DAY(ADD_MONTHS(CAST(TRUNC(${asDate}, 'YYYY') AS DATE), 11))`;
      default:
        return this.periodAverageToDateExpr(bucketColumn);
    }
  }

  periodAverageIntervalStartExpr(interval: string, bucketColumn: string): string {
    switch (interval) {
      case 'day':
        return this.periodAverageToDateExpr(bucketColumn);
      case 'month':
        return `CAST(TRUNC(CAST(${bucketColumn} AS DATE), 'MM') AS DATE)`;
      case 'quarter':
        return `CAST(TRUNC(CAST(${bucketColumn} AS DATE), 'Q') AS DATE)`;
      case 'year':
        return `CAST(TRUNC(CAST(${bucketColumn} AS DATE), 'YYYY') AS DATE)`;
      default:
        throw new UserError(`Unsupported period_average interval '${interval}'`);
    }
  }

  periodAverageIntervalBucketFromAvgUnit(avgUnitBucket: string, interval: string): string {
    switch (interval) {
      case 'day':
        return avgUnitBucket;
      case 'month':
        return `TRUNC(CAST(${avgUnitBucket} AS DATE), 'MM')`;
      case 'quarter':
        return `TRUNC(CAST(${avgUnitBucket} AS DATE), 'Q')`;
      case 'year':
        return `TRUNC(CAST(${avgUnitBucket} AS DATE), 'YYYY')`;
      default:
        throw new UserError(`Unsupported period_average interval '${interval}'`);
    }
  }

  daysBetweenInclusive(start: string, end: string): string {
    return `GREATEST((CAST(${end} AS DATE) - CAST(${start} AS DATE) + 1), 0)`;
  }

  monthsBetweenInclusive(start: string, end: string): string {
    return `GREATEST(FLOOR(MONTHS_BETWEEN(CAST(${end} AS DATE), CAST(${start} AS DATE))) + 1, 0)`;
  }

  quartersBetweenInclusive(start: string, end: string): string {
    return `GREATEST(FLOOR(MONTHS_BETWEEN(CAST(${end} AS DATE), CAST(${start} AS DATE)) / 3) + 1, 0)`;
  }

  yearsBetweenInclusive(start: string, end: string): string {
    return `GREATEST(FLOOR(MONTHS_BETWEEN(CAST(${end} AS DATE), CAST(${start} AS DATE)) / 12) + 1, 0)`;
  }

  /**
   * Oracle：双引号 `"cube".col` 由默认实现覆盖；未加引号时 Oracle 会折叠为大写，
   * 故在默认实现之外补充大小写不敏感的无引号匹配 `cube.col`（含 Cube/CUBE 等变体）。
   */
  ownedCubeQualifiedColumnReplacements(cubeName, cubeAlias, escapedCubeName) {
    return [
      ...super.ownedCubeQualifiedColumnReplacements(cubeName, cubeAlias, escapedCubeName),
      {
        pattern: new RegExp(`(^|[^A-Za-z0-9_$."'\`\\[])${escapedCubeName}\\s*\\.`, 'gi'),
        replacement: `$1${cubeAlias}.`,
      },
    ];
  }
}
