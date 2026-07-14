import R from 'ramda';
import moment from 'moment-timezone';
import { getEnv, QueryAlias, parseSqlInterval } from '@cubejs-backend/shared';
import { BaseQuery } from './BaseQuery';
import { BaseFilter } from './BaseFilter';
import { UserError } from '../compiler/UserError';
import { BaseTimeDimension } from './BaseTimeDimension';

const GRANULARITY_TO_INTERVAL = {
  day: (date: string) => `DATE_FORMAT(${date}, '%Y-%m-%dT00:00:00.000')`,
  week: (date: string) => `DATE_FORMAT(DATE_ADD('1900-01-01', INTERVAL TIMESTAMPDIFF(WEEK, '1900-01-01', ${date}) WEEK), '%Y-%m-%dT00:00:00.000')`,
  hour: (date: string) => `DATE_FORMAT(${date}, '%Y-%m-%dT%H:00:00.000')`,
  minute: (date: string) => `DATE_FORMAT(${date}, '%Y-%m-%dT%H:%i:00.000')`,
  second: (date: string) => `DATE_FORMAT(${date}, '%Y-%m-%dT%H:%i:%S.000')`,
  month: (date: string) => `DATE_FORMAT(${date}, '%Y-%m-01T00:00:00.000')`,
  quarter: (date: string) => `DATE_ADD('1900-01-01', INTERVAL TIMESTAMPDIFF(QUARTER, '1900-01-01', ${date}) QUARTER)`,
  year: (date: string) => `DATE_FORMAT(${date}, '%Y-01-01T00:00:00.000')`
};

class MysqlFilter extends BaseFilter {
  public likeIgnoreCase(column: string, not: boolean, param, type: string) {
    const p = (!type || type === 'contains' || type === 'ends') ? '%' : '';
    const s = (!type || type === 'contains' || type === 'starts') ? '%' : '';
    return `${column}${not ? ' NOT' : ''} LIKE CONCAT('${p}', ${this.allocateParam(param)}, '${s}')`;
  }
}

export class MysqlQuery extends BaseQuery {
  private readonly useNamedTimezones: boolean;

  public constructor(compilers: any, options: any) {
    super(compilers, options);

    this.useNamedTimezones = getEnv('mysqlUseNamedTimezones', { dataSource: this.dataSource });
  }

  /**
   * MySQL cannot use SELECT-list position in `expr IS NULL` patterns: `ORDER BY 1 IS NULL`
   * treats `1` as a literal, not the first column. Use column aliases instead (see
   * `orderHashToString`); `getFieldOrderExpr` adds `q_0.` when JOINs would make aliases ambiguous.
   *
   * Aggregate measures must repeat the full expression in ORDER BY — MySQL rejects
   * `ORDER BY <aggregate_alias>` even when GROUP BY uses column expressions.
   */
  protected usePositionalOrderBy() {
    return false;
  }

  public getFieldOrderExpr(id: string) {
    const equalIgnoreCase = (a: string, b: string) => (
      typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()
    );

    const measure = this.measures.find(
      (d) => equalIgnoreCase(d.measure, id) || equalIgnoreCase(d.expressionName, id),
    );

    if (measure) {
      if (
        (measure.isSemiAdditive && measure.isSemiAdditive())
        || this.queryReferencesSemiAdditiveMeasures()
      ) {
        return super.getFieldOrderExpr(id);
      }
      // Non-semi-additive aggregates on simpleQuery must repeat measureSql() on MySQL.
      return measure.measureSql();
    }

    return super.getFieldOrderExpr(id);
  }

  /**
   * MySQL doesn't reliably support `NULLS FIRST/LAST` in ORDER BY.
   * Make NULL the minimum value:
   * - ASC  -> NULLs first:  `expr IS NULL DESC, expr ASC`
   * - DESC -> NULLs last:   `expr IS NULL ASC,  expr DESC`
   */
  public orderHashToString(hash: { id: string; desc: boolean }) {
    if (!hash || !hash.id) {
      return null;
    }

    const expr = this.getFieldOrderExpr(hash.id);
    if (expr === null) {
      return null;
    }

    const asc = !hash.desc;
    const nullsFirst = asc;
    return `${expr} IS NULL ${nullsFirst ? 'DESC' : 'ASC'}, ${expr} ${asc ? 'ASC' : 'DESC'}`;
  }

  public newFilter(filter) {
    return new MysqlFilter(this, filter);
  }

  /**
   * MySQL rejects `ORDER BY <aggregate_alias>` when `GROUP BY` uses positional
   * indexes (`GROUP BY 1`). Use dimension expressions instead (same approach as MSSQL).
   */
  public groupByClause() {
    if (this.ungrouped) {
      return '';
    }
    const dimensionColumns = R.flatten(
      this.dimensionsForSelect().map((s) => s.selectColumns() && s.dimensionSql())
    ).filter((s) => !!s);
    return dimensionColumns.length ? ` GROUP BY ${dimensionColumns.join(', ')}` : '';
  }

  public aggregateSubQueryGroupByClause() {
    const dimensionColumns = this.dimensionColumns(this.escapeColumnName(QueryAlias.AGG_SUB_QUERY_KEYS));
    return dimensionColumns.length ? ` GROUP BY ${dimensionColumns.join(', ')}` : '';
  }

  public castToString(sql: string) {
    return `CAST(${sql} as CHAR)`;
  }

  public convertTz(field: string) {
    if (this.useNamedTimezones) {
      return `CONVERT_TZ(${field}, @@session.time_zone, '${this.timezone}')`;
    }

    return `CONVERT_TZ(${field}, @@session.time_zone, '${moment().tz(this.timezone).format('Z')}')`;
  }

  public timeStampCast(value: string) {
    return `TIMESTAMP(convert_tz(${value}, '+00:00', @@session.time_zone))`;
  }

  public timestampFormat() {
    return 'YYYY-MM-DDTHH:mm:ss.SSS';
  }

  public dateTimeCast(value: string) {
    return `TIMESTAMP(${value})`;
  }

  public subtractInterval(date: string, interval: string) {
    return `DATE_SUB(${date}, INTERVAL ${this.formatInterval(interval)})`;
  }

  public addInterval(date: string, interval: string) {
    return `DATE_ADD(${date}, INTERVAL ${this.formatInterval(interval)})`;
  }

  public timeGroupedColumn(granularity: string, dimension) {
    return `CAST(${GRANULARITY_TO_INTERVAL[granularity](dimension)} AS DATETIME)`;
  }

  /**
   * Returns sql for source expression floored to timestamps aligned with
   * intervals relative to origin timestamp point.
   */
  public dateBin(interval: string, source: string, origin: string): string {
    const intervalFormatted = this.formatInterval(interval);
    const timeUnit = this.isIntervalYM(interval) ? 'MONTH' : 'SECOND';

    return `TIMESTAMPADD(${timeUnit},
        FLOOR(
          TIMESTAMPDIFF(${timeUnit}, ${this.dateTimeCast(`'${origin}'`)}, ${source}) /
          TIMESTAMPDIFF(${timeUnit}, '1970-01-01 00:00:00', '1970-01-01 00:00:00' + INTERVAL ${intervalFormatted})
        ) * TIMESTAMPDIFF(${timeUnit}, '1970-01-01 00:00:00', '1970-01-01 00:00:00' + INTERVAL ${intervalFormatted}),
        ${this.dateTimeCast(`'${origin}'`)}
    )`;
  }

  private isIntervalYM(interval: string): boolean {
    return /(year|month|quarter)/i.test(interval);
  }

  /**
   * The input interval with (possible) plural units, like "2 years", "3 months", "4 weeks", "5 days"...
   * will be converted to MYSQL dialect.
   * @see https://dev.mysql.com/doc/refman/8.4/en/expressions.html#temporal-intervals
   */
  private formatInterval(interval: string): string {
    const intervalParsed = parseSqlInterval(interval);
    const intKeys = Object.keys(intervalParsed).length;

    if (intervalParsed.year && intKeys === 1) {
      return `${intervalParsed.year} YEAR`;
    } else if (intervalParsed.year && intervalParsed.month && intKeys === 2) {
      return `'${intervalParsed.year}-${intervalParsed.month}' YEAR_MONTH`;
    } else if (intervalParsed.quarter && intKeys === 1) {
      return `${intervalParsed.quarter} QUARTER`;
    } else if (intervalParsed.month && intKeys === 1) {
      return `${intervalParsed.month} MONTH`;
    } else if (intervalParsed.week && intKeys === 1) {
      return `${intervalParsed.week} WEEK`;
    } else if (intervalParsed.day && intKeys === 1) {
      return `${intervalParsed.day} DAY`;
    } else if (intervalParsed.day && intervalParsed.hour && intKeys === 2) {
      return `'${intervalParsed.day} ${intervalParsed.hour}' DAY_HOUR`;
    } else if (intervalParsed.day && intervalParsed.hour && intervalParsed.minute && intKeys === 3) {
      return `'${intervalParsed.day} ${intervalParsed.hour}:${intervalParsed.minute}' DAY_MINUTE`;
    } else if (intervalParsed.day && intervalParsed.hour && intervalParsed.minute && intervalParsed.second && intKeys === 4) {
      return `'${intervalParsed.day} ${intervalParsed.hour}:${intervalParsed.minute}:${intervalParsed.second}' DAY_SECOND`;
    } else if (intervalParsed.hour && intervalParsed.minute && intKeys === 2) {
      return `'${intervalParsed.hour}:${intervalParsed.minute}' HOUR_MINUTE`;
    } else if (intervalParsed.hour && intervalParsed.minute && intervalParsed.second && intKeys === 3) {
      return `'${intervalParsed.hour}:${intervalParsed.minute}:${intervalParsed.second}' HOUR_SECOND`;
    } else if (intervalParsed.minute && intervalParsed.second && intKeys === 2) {
      return `'${intervalParsed.minute}:${intervalParsed.second}' MINUTE_SECOND`;
    } else if (intervalParsed.hour && intKeys === 1) {
      return `${intervalParsed.hour} HOUR`;
    } else if (intervalParsed.minute && intKeys === 1) {
      return `${intervalParsed.minute} MINUTE`;
    } else if (intervalParsed.second && intKeys === 1) {
      return `${intervalParsed.second} SECOND`;
    } else if (intervalParsed.millisecond && intKeys === 1) {
      // MySQL doesn't support MILLISECOND, use MICROSECOND instead (1ms = 1000μs)
      return `${intervalParsed.millisecond * 1000} MICROSECOND`;
    }

    throw new Error(`Cannot transform interval expression "${interval}" to MySQL dialect`);
  }

  public escapeColumnName(name: string): string {
    return `\`${name}\``;
  }

  /**
   * MySQL 系：在默认的双引号 + 无引号基础上，补充反引号限定写法 `​`​`cube``。
   */
  ownedCubeQualifiedColumnReplacements(
    cubeName: string,
    cubeAlias: string,
    escapedCubeName: string,
  ) {
    return [
      ...super.ownedCubeQualifiedColumnReplacements(cubeName, cubeAlias, escapedCubeName),
      {
        pattern: new RegExp(`\`${escapedCubeName}\`\\s*\\.`, 'g'),
        replacement: `${cubeAlias}.`,
      },
    ];
  }

  public seriesSql(timeDimension: BaseTimeDimension): string {
    const values = timeDimension.timeSeries().map(
      ([from, to]) => `select '${from}' f, '${to}' t`
    ).join(' UNION ALL ');
    return `SELECT TIMESTAMP(dates.f) date_from, TIMESTAMP(dates.t) date_to FROM (${values}) AS dates`;
  }

  public concatStringsSql(strings: string[]): string {
    return `CONCAT(${strings.join(', ')})`;
  }

  public unixTimestampSql(): string {
    return 'UNIX_TIMESTAMP()';
  }

  public wrapSegmentForDimensionSelect(sql: string): string {
    return `IF(${sql}, 1, 0)`;
  }

  public preAggregationTableName(cube: string, preAggregationName: string, skipSchema: boolean): string {
    const name = super.preAggregationTableName(cube, preAggregationName, skipSchema);
    if (name.length > 64) {
      throw new UserError(`MySQL can not work with table names that longer than 64 symbols. Consider using the 'sqlAlias' attribute in your cube and in your pre-aggregation definition for ${name}.`);
    }
    return name;
  }

  public supportGeneratedSeriesForCustomTd(): boolean {
    return true;
  }

  public intervalString(interval: string): string {
    return this.formatInterval(interval);
  }

  // ==========================================================================
  // period_average 方言适配区（MySQL）
  //
  // 下面方法均是对 BaseQuery 中 PostgreSQL 风格默认实现的重写，将日期/时间函数
  // 替换为 MySQL 语法。适配新数据库时，参照本区块重写下列方法（详见 BaseQuery
  // 中各方法的 @dialect 注释）：
  //   - periodAverageDateLiteral / periodAverageToDateExpr  日期字面量与转 DATE
  //   - periodAverageNowExpr             当前日期（带时区 CONVERT_TZ）
  //   - periodAverageGroupedBucketExpr   窗口列 MIN 包装
  //   - periodAverageClosedFormIntervalBucketUnits  整区间 calendar 快路径（先 super）
  //   - periodAverageCumulativeCalendarUnitCount    累计 calendar 快路径（先 super）
  //   - periodAverageDaysIn{Month,Quarter,Year}Bucket  桶内天数
  //   - periodAverageBucketEndExpr       区间终点
  //   - periodAverageIntervalStartExpr   区间起点
  //   - periodAverageIntervalBucketFromAvgUnit  从 avg_unit 列推区间桶
  //   - {days,months,quarters,years}BetweenInclusive  间隔计数（TIMESTAMPDIFF）
  //   - ownedCubeQualifiedColumnReplacements  标识符引号规则（本库：反引号 + super）
  // ==========================================================================

  periodAverageDateLiteral(dateStr: string): string {
    return `DATE('${dateStr}')`;
  }

  periodAverageNowExpr(): string {
    const frozenNow = process.env.CUBEJS_TEST_NOW;
    if (frozenNow) {
      return this.periodAverageDateLiteral(frozenNow);
    }
    if (this.useNamedTimezones) {
      return `DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '${this.timezone}'))`;
    }
    return `DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '${moment().tz(this.timezone).format('Z')}'))`;
  }

  periodAverageToDateExpr(sql: string): string {
    return `DATE(${sql})`;
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
      return `GREATEST(DATEDIFF(${current}, ${intervalStart}) + 1, 0)`;
    }
    if (avgUnit === 'month' && (interval === 'year' || interval === 'quarter' || interval === 'month')) {
      return `GREATEST(MONTH(${current}) - MONTH(${intervalStart}) + 1, 0)`;
    }
    return null;
  }

  periodAverageDaysInMonthBucket(bucketColumn: string) {
    return `GREATEST(DAY(LAST_DAY(${bucketColumn})), 0)`;
  }

  periodAverageDaysInQuarterBucket(bucketColumn: string) {
    return `GREATEST(DATEDIFF(LAST_DAY(DATE_ADD(${bucketColumn}, INTERVAL 2 MONTH)), DATE(DATE_FORMAT(${bucketColumn}, '%Y-%m-01'))) + 1, 0)`;
  }

  periodAverageDaysInYearBucket(bucketColumn: string) {
    return `GREATEST(DATEDIFF(DATE(CONCAT(YEAR(${bucketColumn}), '-12-31')), DATE(CONCAT(YEAR(${bucketColumn}), '-01-01'))) + 1, 0)`;
  }

  periodAverageBucketEndExpr(granularity: string, bucketColumn: string): string {
    switch (granularity) {
      case 'day':
        return `DATE(${bucketColumn})`;
      case 'month':
        return `LAST_DAY(${bucketColumn})`;
      case 'quarter':
        return `LAST_DAY(DATE_ADD(${bucketColumn}, INTERVAL 2 MONTH))`;
      case 'year':
        return `DATE(CONCAT(YEAR(${bucketColumn}), '-12-31'))`;
      default:
        return `DATE(${bucketColumn})`;
    }
  }

  periodAverageIntervalStartExpr(interval: string, bucketColumn: string): string {
    switch (interval) {
      case 'day':
        return this.periodAverageToDateExpr(bucketColumn);
      case 'month':
        return `DATE(DATE_FORMAT(${bucketColumn}, '%Y-%m-01'))`;
      case 'quarter':
        return `MAKEDATE(YEAR(${bucketColumn}), 1) + INTERVAL QUARTER(${bucketColumn}) QUARTER - INTERVAL 1 QUARTER`;
      case 'year':
        return `DATE(CONCAT(YEAR(${bucketColumn}), '-01-01'))`;
      default:
        throw new UserError(`Unsupported period_average interval '${interval}'`);
    }
  }

  periodAverageIntervalBucketFromAvgUnit(avgUnitBucket: string, interval: string): string {
    switch (interval) {
      case 'day':
        return avgUnitBucket;
      case 'month':
        return `DATE_FORMAT(${avgUnitBucket}, '%Y-%m-01T00:00:00.000')`;
      case 'quarter': {
        const quarterStart = `MAKEDATE(YEAR(${avgUnitBucket}), 1) + INTERVAL QUARTER(${avgUnitBucket}) QUARTER - INTERVAL 1 QUARTER`;
        return `DATE_FORMAT(${quarterStart}, '%Y-%m-%dT00:00:00.000')`;
      }
      case 'year':
        return `DATE_FORMAT(${avgUnitBucket}, '%Y-01-01T00:00:00.000')`;
      default:
        throw new UserError(`Unsupported period_average interval '${interval}'`);
    }
  }

  daysBetweenInclusive(start: string, end: string): string {
    return `GREATEST((DATEDIFF(${end}, ${start}) + 1), 0)`;
  }

  monthsBetweenInclusive(start: string, end: string): string {
    return `GREATEST((TIMESTAMPDIFF(MONTH, ${start}, ${end}) + 1), 0)`;
  }

  quartersBetweenInclusive(start: string, end: string): string {
    return `GREATEST((TIMESTAMPDIFF(QUARTER, ${start}, ${end}) + 1), 0)`;
  }

  yearsBetweenInclusive(start: string, end: string): string {
    return `GREATEST((TIMESTAMPDIFF(YEAR, ${start}, ${end}) + 1), 0)`;
  }

  public sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.functions.STRING_AGG = 'GROUP_CONCAT({% if distinct %}DISTINCT {% endif %}{{ args[0] }} SEPARATOR {{ args[1] }})';
    // PERCENTILE_CONT works but requires PARTITION BY
    delete templates.functions.PERCENTILECONT;
    templates.quotes.identifiers = '`';
    templates.quotes.escape = '\\`';
    // NOTE: this template contains a comma; two order expressions are being generated
    templates.expressions.sort = '{{ expr }} IS NULL {% if nulls_first %}DESC{% else %}ASC{% endif %}, {{ expr }} {% if asc %}ASC{% else %}DESC{% endif %}';
    // MySQL: avoid unconditional NULLS FIRST/LAST from BaseQuery (support varies); keep deterministic NULL ordering via JS `orderHashToString`.
    // Tesseract: avoid GROUP BY 1,2,3 and positional ORDER BY (MySQL treats `1` in `1 IS NULL` as literal).
    templates.statements.group_by_exprs = '{{ group_by | map(attribute=\'expr\') | join(\', \') }}';
    templates.expressions.order_by = '{{ expr }} {% if asc %}ASC{% else %}DESC{% endif %}';
    delete templates.expressions.ilike;
    templates.types.string = 'CHAR';
    templates.types.boolean = 'TINYINT';
    templates.types.timestamp = 'DATETIME';
    delete templates.types.interval;
    templates.types.binary = 'BLOB';
    // MySQL has no FULL OUTER JOIN
    delete templates.join_types.full;

    templates.expressions.concat_strings = 'CONCAT({{ strings | join(\',\' ) }})';

    templates.filters.like_pattern = 'CONCAT({% if start_wild %}\'%\'{% else %}\'\'{% endif %}, LOWER({{ value }}), {% if end_wild %}\'%\'{% else %}\'\'{% endif %})';
    templates.tesseract.ilike = 'LOWER({{ expr }}) {% if negated %}NOT {% endif %}LIKE {{ pattern }}';

    templates.statements.time_series_select = 'SELECT TIMESTAMP(dates.f) date_from, TIMESTAMP(dates.t) date_to \n' +
      'FROM (\n' +
      '{% for time_item in seria  %}' +
      '    select \'{{ time_item[0] }}\' f, \'{{ time_item[1] }}\' t \n' +
      '{% if not loop.last %} UNION ALL\n{% endif %}' +
      '{% endfor %}' +
      ') AS dates';

    templates.statements.generated_time_series_select =
      'WITH RECURSIVE date_series AS (\n' +
      '  SELECT TIMESTAMP({{ start }}) AS date_from\n' +
      '  UNION ALL\n' +
      '  SELECT DATE_ADD(date_from, INTERVAL {{ granularity }})\n' +
      '  FROM date_series\n' +
      '  WHERE DATE_ADD(date_from, INTERVAL {{ granularity }}) <= TIMESTAMP({{ end }})\n' +
      ')\n' +
      'SELECT CAST(date_from AS DATETIME) AS date_from,\n' +
      '       CAST(DATE_SUB(DATE_ADD(date_from, INTERVAL {{ granularity }}), INTERVAL 1000 MICROSECOND) AS DATETIME(3)) AS date_to\n' +
      'FROM date_series';

    templates.statements.generated_time_series_with_cte_range_source =
      'WITH RECURSIVE date_series AS (\n' +
      '  SELECT {{ range_source }}.{{ min_name }} AS date_from,\n' +
      '         {{ range_source }}.{{ max_name }} AS max_date\n' +
      '  FROM {{ range_source }}\n' +
      '  UNION ALL\n' +
      '  SELECT DATE_ADD(date_from, INTERVAL {{ granularity }}), max_date\n' +
      '  FROM date_series\n' +
      '  WHERE DATE_ADD(date_from, INTERVAL {{ granularity }}) <= max_date\n' +
      ')\n' +
      'SELECT CAST(date_from AS DATETIME) AS date_from,\n' +
      '       CAST(DATE_SUB(DATE_ADD(date_from, INTERVAL {{ granularity }}), INTERVAL 1000 MICROSECOND) AS DATETIME(3)) AS date_to\n' +
      'FROM date_series';
    templates.expressions.wrap_segment_select = 'IF({{ expr }}, 1, 0)';
    templates.expressions.wrap_segment_filter = '{{ expr }} = 1';

    return templates;
  }
}
