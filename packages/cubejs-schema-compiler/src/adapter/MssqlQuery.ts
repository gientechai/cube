import R from 'ramda';
import moment from 'moment-timezone';

import { QueryAlias, parseSqlInterval } from '@cubejs-backend/shared';
import { BaseQuery } from './BaseQuery';
import { BaseFilter } from './BaseFilter';
import { BaseSegment } from './BaseSegment';
import { BaseMeasure } from './BaseMeasure';
import { ParamAllocator } from './ParamAllocator';

const abbrs = {
  EST: 'Eastern Standard Time',
  EDT: 'Eastern Standard Time',
  CST: 'Central Standard Time',
  CDT: 'Central Standard Time',
  MST: 'Mountain Standard Time',
  MDT: 'Mountain Standard Time',
  PST: 'Pacific Standard Time',
  PDT: 'Pacific Standard Time',
};

moment.fn.zoneName = () => {
  // @ts-ignore
  const abbr = this.zoneAbbr();
  return abbrs[abbr] || abbr;
};

class MssqlParamAllocator extends ParamAllocator {
  public paramPlaceHolder(paramIndex) {
    return `@_${paramIndex + 1}`;
  }
}

const GRANULARITY_TO_INTERVAL = {
  day: (date) => `dateadd(day, DATEDIFF(day, 0, ${date}), 0)`,
  week: (date) => `dateadd(week, DATEDIFF(week, 0, ${date}), 0)`,
  hour: (date) => `dateadd(hour, DATEDIFF(hour, 0, ${date}), 0)`,
  minute: (date) => `dateadd(minute, DATEDIFF(minute, 0, ${date}), 0)`,
  second: (date) => `CAST(FORMAT(${date}, 'yyyy-MM-ddTHH:mm:ss.000') AS DATETIME2)`, // until SQL 2016, this causes an int overflow; in SQL 2016 these calls can be changed to DATEDIFF_BIG
  month: (date) => `dateadd(month, DATEDIFF(month, 0, ${date}), 0)`,
  quarter: (date) => `dateadd(quarter, DATEDIFF(quarter, 0, ${date}), 0)`,
  year: (date) => `dateadd(year, DATEDIFF(year, 0, ${date}), 0)`,
};

class MssqlFilter extends BaseFilter {
  // noinspection JSMethodCanBeStatic
  public escapeWildcardChars(param) {
    return typeof param === 'string' ? param.replace(/([_%[])/g, '[$1]') : param;
  }

  public likeIgnoreCase(column, not, param, type) {
    const p = (!type || type === 'contains' || type === 'ends') ? '%' : '';
    const s = (!type || type === 'contains' || type === 'starts') ? '%' : '';
    return `LOWER(${column})${not ? ' NOT' : ''} LIKE CONCAT('${p}', LOWER(${this.allocateParam(param)}) , '${s}')`;
  }
}

class MssqlSegment extends BaseSegment {
  public filterToWhere(): string {
    const where = super.filterToWhere();

    const context = this.query.safeEvaluateSymbolContext();
    if (context.rollupQuery) {
      // Segment itself will be rendered as reference for rollupQuery
      // In MSSQL using just `WHERE (segment_column) AND (other_filter)` is incorrect, because
      // `segment_column` is not of boolean type, but of `BIT` type
      // Correct way to work with them is to use `WHERE segment_column = 1`
      // This relies on `wrapSegmentForDimensionSelect` mapping segment to a `BIT` data type
      return `${where} = 1`;
    }

    return where;
  }
}

class MssqlExpressionMeasure extends BaseMeasure {
  public measureDefinition() {
    // BaseMeasure's non-additive setup must not resolve an expression as a path.
    return this.expression ? this.definition() : super.measureDefinition();
  }
}

export class MssqlQuery extends BaseQuery {
  public constructor(compilers: any, options: any) {
    // SQL API wrappers require exact aliases and may supply expression measures.
    // The native inner planner does not yet preserve either contract; keep this
    // fallback local to MSSQL while ordinary queries retain their planner setting.
    const requiresSqlApiRenderer = Object.keys(options.memberToAlias || {}).length > 0 ||
      (options.measures || []).some(measure => measure && typeof measure === 'object');
    super(compilers, requiresSqlApiRenderer ? { ...options, useNativeSqlPlanner: false } : options);
  }

  public newFilter(filter) {
    return new MssqlFilter(this, filter);
  }

  public newSegment(segment): BaseSegment {
    return new MssqlSegment(this, segment);
  }

  public newMeasure(measure): BaseMeasure {
    return measure?.expression ? new MssqlExpressionMeasure(this, measure) : super.newMeasure(measure);
  }

  public everyRefreshKeySql(refreshKey, external = false) {
    if (this.externalQueryClass && this.measures.some(measure => measure.expression)) {
      // A clock-based external refresh key only needs the timezone. Copying
      // MSSQL expression measures into the external dialect is unnecessary.
      const ExternalQuery = this.externalQueryClass;
      const refreshQuery = new ExternalQuery(this.compilers, {
        timezone: this.timezone,
        externalQueryClass: null,
        useNativeSqlPlanner: false,
      });
      return refreshQuery.everyRefreshKeySql(refreshKey, true);
    }
    return super.everyRefreshKeySql(refreshKey, external);
  }

  // Keep expression/alias ordering consistent with the native planner.
  protected usePositionalOrderBy() {
    return false;
  }

  /**
   * SQL Server already treats NULL as the minimum value. A boolean IS NULL
   * sort item is invalid, and embedding a SELECT alias in CASE is also invalid.
   */
  public orderHashToString(hash: { id: string; desc: boolean }) {
    if (!hash || !hash.id) {
      return null;
    }

    const expr = this.getFieldOrderExpr(hash.id);
    if (expr === null) {
      return null;
    }

    return `${expr} ${hash.desc ? 'DESC' : 'ASC'}`;
  }

  public orderBy() {
    const orderBy = super.orderBy();
    if (orderBy || (this.rowLimit === null && !this.offset)) {
      return orderBy;
    }

    // OFFSET requires ORDER BY in MSSQL. Give TOP pages the same fallback,
    // sorting by every grouping key so adjacent aggregate pages are consistent.
    const columns = this.dimensionColumns(this.orderByJoinAmbiguity ? 'q_0' : '');
    return ` ORDER BY ${(columns.length ? columns : ['1']).map(column => `${column} ASC`).join(', ')}`;
  }

  public castToString(sql) {
    return `CAST(${sql} as VARCHAR)`;
  }

  public concatStringsSql(strings: string[]) {
    return strings.join(' + ');
  }

  public convertTz(field) {
    const offset = moment().tz(this.timezone).format('Z');

    // 1. Treating the field as UTC (add '+00:00' offset)
    // 2. Switch to target timezone offset
    // 3. Cast to DATETIME2 to get naive timestamp in target timezone
    return `CAST(SWITCHOFFSET(TODATETIMEOFFSET(${field}, '+00:00'), '${offset}') AS DATETIME2)`;
  }

  public timeStampCast(value: string) {
    return `CAST(${value} AS DATETIMEOFFSET)`;
  }

  public dateTimeCast(value: string) {
    return `CAST(${value} AS DATETIME2)`;
  }

  public timeGroupedColumn(granularity: string, dimension: string): string {
    return GRANULARITY_TO_INTERVAL[granularity](dimension);
  }

  /**
   * Returns SQL for source expression floored to timestamps aligned with
   * intervals relative to the origin timestamp point.
   * The formula operates with seconds diffs, so it won't produce human-expected dates aligned with offset date parts.
   */
  public dateBin(interval: string, source: string, origin: string): string {
    // Both source and origin are now DATETIME2 in the query timezone (naive timestamps),
    // ensuring their in the same timezone context for correct date bin calculation.
    const originAligned = this.dateTimeCast(`'${origin}'`);
    const beginOfTime = this.dateTimeCast('DATEFROMPARTS(1970, 1, 1)');
    const timeUnit = this.diffTimeUnitForInterval(interval);

    // Need to explicitly cast one argument of floor to float to trigger correct sign logic
    return `DATEADD(${timeUnit},
        FLOOR(
          CAST(DATEDIFF(${timeUnit}, ${originAligned}, ${source}) AS FLOAT) /
          DATEDIFF(${timeUnit}, ${beginOfTime}, ${this.addInterval(beginOfTime, interval)})
        ) * DATEDIFF(${timeUnit}, ${beginOfTime}, ${this.addInterval(beginOfTime, interval)}),
        ${originAligned}
    )`;
  }

  public newParamAllocator(expressionParams) {
    return new MssqlParamAllocator(expressionParams);
  }

  // TODO replace with limitOffsetClause override
  public groupByDimensionLimit() {
    if (this.rowLimit) {
      return this.offset ? ` OFFSET ${parseInt(this.offset, 10)} ROWS FETCH NEXT ${parseInt(this.rowLimit, 10)} ROWS ONLY` : '';
    } else {
      return this.offset ? ` OFFSET ${parseInt(this.offset, 10)} ROWS` : '';
    }
  }

  public topLimit() {
    if (this.offset) {
      return '';
    }
    const limit = this.rowLimit === undefined ? 10000 : parseInt(this.rowLimit, 10);
    return this.rowLimit === null ? '' : ` TOP (${limit}) `;
  }

  public buildSemiAdditiveCTEQuery(
    originalQuery: string,
    measures: BaseMeasure[],
    baseColumns: string[],
    timeDimensionsForOrdering: string[] = [],
    dimensionsForSemiAdditiveRemap: unknown[] = [],
    semiAdditiveMeasuresForCte?: BaseMeasure[],
  ): string {
    // MSSQL cannot put WITH inside a derived table (including total queries).
    // Reuse the shared projection/measure renderer, converting only its fixed
    // scaffold. Keep the source SQL out of this conversion to preserve literals,
    // comments and parameters without attempting to parse arbitrary SQL.
    const sourceMarker = '__mssql_semi_additive_source__';
    const rendered = super.buildSemiAdditiveCTEQuery(
      sourceMarker, measures, baseColumns, timeDimensionsForOrdering,
      dimensionsForSemiAdditiveRemap, semiAdditiveMeasuresForCte,
    );
    if (rendered === sourceMarker) {
      return originalQuery;
    }
    const prefix = `WITH base_data AS (\n  ${sourceMarker}\n), windowed_data AS (\n  SELECT `;
    const separator = '\n  FROM base_data\n)\nSELECT ';
    const middle = rendered.lastIndexOf(separator);
    const from = rendered.lastIndexOf(' FROM windowed_data');
    if (!rendered.startsWith(prefix) || middle < prefix.length || from < middle + separator.length) {
      throw new Error('Unexpected semi-additive query structure for MSSQL');
    }
    const windowProjection = rendered.slice(prefix.length, middle);
    const finalProjection = rendered.slice(middle + separator.length, from);
    const groupBy = rendered.slice(from + ' FROM windowed_data'.length);
    return `SELECT ${finalProjection} FROM (\n` +
      `  SELECT ${windowProjection} FROM (\n${originalQuery}\n) AS base_data\n` +
      `) AS windowed_data${groupBy}`;
  }

  /**
   * Overrides `BaseQuery#groupByClause` method and returns `GROUP BY` clause
   * with the column names instead of column numeric sequences as MSSQL does
   * not support this format.
   * @returns {string}
   * @override
   */
  public groupByClause() {
    if (this.ungrouped) {
      return '';
    }
    const dimensionsForSelect = this.dimensionsForSelect();
    const dimensionColumns = R.flatten(
      dimensionsForSelect.map(s => s.selectColumns() && s.dimensionSql())
    ).filter(s => !!s);
    return dimensionColumns.length ? ` GROUP BY ${dimensionColumns.join(', ')}` : '';
  }

  /**
   * Overrides `BaseQuery#aggregateSubQueryGroupByClause` method and returns
   * `GROUP BY` clause for the "aggregating on top of sub-queries" uses cases.
   * @returns {string}
   * @override
   */
  public aggregateSubQueryGroupByClause() {
    const dimensionColumns = this.dimensionColumns(this.escapeColumnName(QueryAlias.AGG_SUB_QUERY_KEYS));
    return dimensionColumns.length ? ` GROUP BY ${dimensionColumns.join(', ')}` : '';
  }

  public overTimeSeriesSelect(cumulativeMeasures, dateSeriesSql, baseQuery, dateJoinConditionSql, baseQueryAlias) {
    // Group by time dimensions
    const timeDimensionsColumns = this.timeDimensions.map(
      (t) => `${t.dateSeriesAliasName()}.${this.escapeColumnName('date_from')}`
    );

    // Group by regular dimensions
    const dimensionColumns = R.flatten(
      this.dimensions.map(s => s.selectColumns() && s.dimensionSql() && s.aliasName())
    ).filter(s => !!s);

    // Combine time dimensions and regular dimensions for GROUP BY clause
    const allGroupByColumns = timeDimensionsColumns.concat(dimensionColumns);

    const forSelect = this.overTimeSeriesForSelect(cumulativeMeasures);
    return (
      `SELECT ${forSelect} FROM ${dateSeriesSql}` +
      ` LEFT JOIN (${baseQuery}) ${this.asSyntaxJoin} ${baseQueryAlias} ON ${dateJoinConditionSql}` +
      ` GROUP BY ${allGroupByColumns.join(', ')}`
    );
  }

  public nowTimestampSql() {
    return 'CURRENT_TIMESTAMP';
  }

  public unixTimestampSql() {
    // eslint-disable-next-line quotes
    return `DATEDIFF(SECOND,'1970-01-01', GETUTCDATE())`;
  }

  public preAggregationLoadSql(cube, preAggregation, tableName) {
    const sqlAndParams = this.preAggregationSql(cube, preAggregation);
    return [`SELECT * INTO ${tableName} FROM (${sqlAndParams[0]}) AS PreAggregation`, sqlAndParams[1]];
  }

  public wrapSegmentForDimensionSelect(sql) {
    return `CAST((CASE WHEN ${sql} THEN 1 ELSE 0 END) AS BIT)`;
  }

  public seriesSql(timeDimension) {
    const values = timeDimension.timeSeries().map(([from, to]) => `('${from}', '${to}')`);
    return `SELECT ${this.dateTimeCast('date_from')} date_from, ${this.dateTimeCast(
      'date_to'
    )} date_to FROM (VALUES ${values}) ${this.asSyntaxTable} dates (date_from, date_to)`;
  }

  public subtractInterval(date: string, interval: string): string {
    const intervalParsed = parseSqlInterval(interval);
    let res = date;

    for (const [key, value] of Object.entries(intervalParsed)) {
      res = `DATEADD(${key}, ${value * -1}, ${res})`;
    }

    return res;
  }

  public addInterval(date: string, interval: string): string {
    const intervalParsed = parseSqlInterval(interval);
    let res = date;

    for (const [key, value] of Object.entries(intervalParsed)) {
      res = `DATEADD(${key}, ${value}, ${res})`;
    }

    return res;
  }

  public sqlTemplates() {
    const templates = super.sqlTemplates();
    // SQL API's compact order contract omits NULL placement. Only collapse a
    // sort into that contract when it agrees with the data source's default.
    templates.capabilities = { mssql_2016_compat: 'true' };
    // Scalar subqueries over VALUES cannot occur inside SUM/AVG on SQL Server.
    // Select the winning argument without a subquery, ignoring NULLs.
    // CHOOSE coerces every operand to the same type, including mixed-type lists.
    const extremeTemplate = (operator: string) => (
      '{% set non_null = args | map("trim") | map("upper") | reject("equalto", "NULL") | list %}' +
      '{% if args | length == 1 %}({{ args[0] }}){% elif args | length > 0 and non_null | length == 0 %}NULL{% else %}' +
      '(CASE {% for arg in args %}{% set candidate = loop.index %}' +
      'WHEN ({{ arg }}) IS NOT NULL {% for other in args %}{% if loop.index != candidate %}' +
      `AND (({{ other }}) IS NULL OR CHOOSE({{ candidate }}, {{ args_concat }}) ${operator} CHOOSE({{ loop.index }}, {{ args_concat }})) ` +
      '{% endif %}{% endfor %}THEN ({{ arg }}) {% endfor %}ELSE NULL END){% endif %}'
    );
    templates.functions.LEAST = extremeTemplate('<=');
    templates.functions.GREATEST = extremeTemplate('>=');
    // NOTE: MSSQL does not support DISTINCT clause. No workaround is available
    delete templates.functions.STRING_AGG;
    // PERCENTILE_CONT works but requires PARTITION BY
    delete templates.functions.PERCENTILECONT;
    delete templates.expressions.ilike;
    // Tesseract renders filters without using MssqlFilter. Keep its case folding
    // and literal contains values in sync with the traditional MSSQL renderer.
    templates.tesseract.ilike = 'LOWER({{ expr }}) {% if negated %}NOT {% endif %}LIKE {{ pattern }}';
    templates.filters.like_pattern = "CONCAT('{% if start_wild %}%{% endif %}', LOWER(" +
      "{% if start_wild and end_wild %}REPLACE(REPLACE(REPLACE({{ value }}, '[', '[[]'), '%', '[%]'), '_', '[_]'){% else %}{{ value }}{% endif %}" +
      "), '{% if end_wild %}%{% endif %}')";
    // SQL API supplies a source expression here, not a same-level SELECT alias.
    // Only explicit ordering opposite to SQL Server's default needs a NULL key.
    templates.expressions.sort = '{% if asc != nulls_first %}CASE WHEN {{ expr }} IS NULL THEN {% if nulls_first %}0{% else %}1{% endif %} ELSE {% if nulls_first %}1{% else %}0{% endif %} END ASC, {% endif %}{{ expr }} {% if asc %}ASC{% else %}DESC{% endif %}';
    templates.types.string = 'VARCHAR';
    templates.types.boolean = 'BIT';
    templates.types.integer = 'INT';
    templates.types.float = 'FLOAT(24)';
    templates.types.double = 'FLOAT(53)';
    templates.types.timestamp = 'DATETIME2';
    delete templates.types.interval;
    templates.types.binary = 'VARBINARY';
    templates.params.param = '@_{{ param_index + 1 }}';
    // MSSQL does not support ordinal GROUP BY (GROUP BY 1, 2), must use expressions
    templates.statements.group_by_exprs = '{{ group_by | map(attribute=\'expr\') | join(\', \') }}';
    // Tesseract supplies explicit ORDER BY expressions here.
    templates.expressions.order_by = '{{ expr }} {% if asc %}ASC{% else %}DESC{% endif %}';
    // MSSQL uses CAST(...AS DATETIME2) instead of ::timestamp
    templates.statements.time_series_select = 'SELECT CAST(date_from AS DATETIME2) AS "date_from",\n' +
      'CAST(date_to AS DATETIME2) AS "date_to" \n' +
      'FROM(\n' +
      '    VALUES ' +
      '{% for time_item in seria  %}' +
      '(\'{{ time_item[0] }}\', \'{{ time_item[1] }}\')' +
      '{% if not loop.last %}, {% endif %}' +
      '{% endfor %}' +
      ') AS dates (date_from, date_to)';
    // MSSQL uses OFFSET/FETCH instead of LIMIT/OFFSET
    templates.statements.select = '{% if ctes %} WITH \n' +
      '{{ ctes | join(\',\n\') }}\n' +
      '{% endif %}' +
      'SELECT {% if distinct %}DISTINCT {% endif %}' +
      '{% if limit == 0 or (limit is not none and not order_by and offset is none) %}TOP ({{ limit }}) {% endif %}' +
      '{{ select_concat | map(attribute=\'aliased\') | join(\', \') }} {% if from %}\n' +
      'FROM (\n' +
      '{{ from | indent(2, true) }}\n' +
      ') AS {{ from_alias }}{% elif from_prepared %}\n' +
      'FROM {{ from_prepared }}' +
      '{% endif %}' +
      '{% if filter %}\nWHERE {{ filter }}{% endif %}' +
      '{% if group_by %}\nGROUP BY {{ group_by }}{% endif %}' +
      '{% if having %}\nHAVING {{ having }}{% endif %}' +
      '{% if order_by or offset is not none %}\nORDER BY {% if order_by %}{{ order_by | map(attribute=\'expr\') | join(\', \') }}{% else %}1{% endif %}' +
      '{% if limit != 0 %}\nOFFSET {% if offset is not none %}{{ offset }}{% else %}0{% endif %} ROWS{% endif %}{% endif %}' +
      '{% if limit is not none and limit != 0 and (order_by or offset is not none) %}\nFETCH NEXT {{ limit }} ROWS ONLY{% endif %}';
    return templates;
  }

  /**
   * 重写：MSSQL 不支持 FILTER 语法，使用 CASE WHEN 替代
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
   * 重写：MSSQL 不支持 FILTER 语法
   *
   * @returns {boolean}
   */
  supportsFilterClause() {
    return false;
  }
}
