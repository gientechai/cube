/**
 * 达梦 (DM) 数据库查询适配：继承 OracleQuery。
 *
 * 从 OracleQuery 继承的、与达梦兼容的行为（不改动 OracleQuery 的 Oracle 语义）：
 * - seriesSql：running total 使用 UNION ALL SELECT ... FROM DUAL（Oracle 同款，达梦复用）。
 * - preAggregationTableName：default schema 加双引号、表名长度限制（Oracle 同款，达梦复用）。
 * - cubeAlias：表别名中 "default" 替换为 "ds_default"（Oracle 同款，达梦复用）。
 *
 * 本文件内达梦专属逻辑：
 * - sqlTemplates：禁用 PERCENTILE_CONT；Tesseract 模板改用列表达式 GROUP BY/ORDER BY（DM 不支持 GROUP BY 1,2,3），
 *   time_series 使用 UNION ALL ... FROM DUAL（DM 不支持 Postgres 式 VALUES 子句）。
 * - cubeAlias：对 DM 返回无引号短别名（≤30 字节），避免「无法解析的成员访问表达式」。
 * - escapeColumnName：对 DM_xxx 短别名不再加引号。
 * - overTimeSeriesSelect：用 WITH DM_BASE AS (...) 替代子查询别名，避免达梦解析错误。
 * - addInterval/subtractInterval：仅「整天」且无时分秒偏移时改用 DATE±N，避免 NUMTODSINTERVAL 升为 TIMESTAMP后与 TO_TIMESTAMP_TZ比较在 DM 上报类型不匹配。
 * - withTimeDimensionDateRangeFromFilters：将 filters.inDateRange 提升到 timeDimensions.dateRange，供 Tesseract rolling window 使用。
 * - generated_time_series_*：DUAL 上 CONNECT BY 生成 gen.lv，再 CROSS JOIN bounds 展开时间轴；无 dateRange 时从 GetDateRange 的 MIN/MAX 推断范围。
 */
import { parseSqlInterval } from '@cubejs-backend/shared';
import { UserError } from '../compiler/UserError';
import { OracleQuery } from './OracleQuery';

const DM_MAX_ALIAS_LENGTH = 30;

/** 确定性字符串哈希，用于生成短别名 */
function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h;
}
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

type QueryFilter = {
  member?: string;
  dimension?: string;
  operator?: string;
  values?: string[];
  and?: QueryFilter[];
  or?: QueryFilter[];
};

type QueryTimeDimension = {
  dimension: string;
  granularity?: string;
  dateRange?: string | [string, string];
};

type QueryOptions = {
  filters?: QueryFilter[];
  timeDimensions?: QueryTimeDimension[];
  [key: string]: unknown;
};

export class DmQuery extends OracleQuery {
  constructor(compilers, options: QueryOptions) {
    super(compilers, DmQuery.withTimeDimensionDateRangeFromFilters(options));
  }

  /**
   * Frontends often send the range only as filters.inDateRange — promote it for time series planning.
   */
  static withTimeDimensionDateRangeFromFilters(options: QueryOptions): QueryOptions {
    if (!options?.timeDimensions?.length || !options?.filters?.length) {
      return options;
    }

    const filterDateRanges = DmQuery.collectInDateRangeFilters(options.filters);
    if (!filterDateRanges.length) {
      return options;
    }

    let changed = false;
    const timeDimensions = options.timeDimensions.map((timeDimension) => {
      if (timeDimension.dateRange) {
        return timeDimension;
      }

      const matchedRange = filterDateRanges.find(
        ({ dimension }) => dimension === timeDimension.dimension
      );
      if (!matchedRange) {
        return timeDimension;
      }

      changed = true;
      return {
        ...timeDimension,
        dateRange: matchedRange.dateRange,
      };
    });

    return changed ? { ...options, timeDimensions } : options;
  }

  private static collectInDateRangeFilters(
    filters: QueryFilter[],
    result: Array<{ dimension: string; dateRange: [string, string] }> = [],
  ): Array<{ dimension: string; dateRange: [string, string] }> {
    filters.forEach((filter) => {
      if (filter.and) {
        DmQuery.collectInDateRangeFilters(filter.and, result);
        return;
      }
      if (filter.or) {
        DmQuery.collectInDateRangeFilters(filter.or, result);
        return;
      }

      const dimension = filter.member || filter.dimension;
      if (
        filter.operator === 'inDateRange'
        && dimension
        && Array.isArray(filter.values)
        && filter.values.length === 2
        && !result.some((entry) => entry.dimension === dimension)
      ) {
        result.push({
          dimension,
          dateRange: [filter.values[0], filter.values[1]],
        });
      }
    });

    return result;
  }

  /**
   * DM 在时间列表达式（常为 TIMESTAMP/DATE）与 TO_TIMESTAMP_TZ 结果比较时易出现「数据类型不匹配」，
   * 将达梦侧的边界值降为无时区 TIMESTAMP，与列类型对齐（仍先用 TO_TIMESTAMP_TZ 解析带 Z 的 ISO 字面量）。
   */
  public override timeStampCast(value: string) {
    return `CAST(${super.timeStampCast(value)} AS TIMESTAMP)`;
  }

  /** DM：DATE ± 整数天仍为 DATE；NUMTODSINTERVAL(day) 常为 TIMESTAMP，与 TO_TIMESTAMP_TZ/CAST 比较易报错。有时分秒时再退回父类。 */
  private static dmUseNumericDayArithmetic(intervalParsed: ReturnType<typeof parseSqlInterval>): boolean {
    return !!intervalParsed.day && !intervalParsed.hour && !intervalParsed.minute && !intervalParsed.second;
  }

  public override addInterval(date: string, interval: string): string {
    const intervalParsed = parseSqlInterval(interval);
    let res = date;

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

    if (intervalParsed.week) {
      // 对于周间隔，需要确保偏移后仍然对齐到 ISO 周的开始（周一）
      // 使用 7 * week 来进行天数偏移，确保 TRUNC(..., 'IW') 能正确对齐
      const weekDays = intervalParsed.week * 7;
      res = `${res} + ${weekDays}`;
    }

    if (intervalParsed.day) {
      if (DmQuery.dmUseNumericDayArithmetic(intervalParsed)) {
        res = `${res} + ${intervalParsed.day}`;
      } else {
        res = `${res} + NUMTODSINTERVAL(${intervalParsed.day}, 'DAY')`;
      }
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

  public override subtractInterval(date: string, interval: string): string {
    const intervalParsed = parseSqlInterval(interval);
    let res = date;

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

    if (intervalParsed.week) {
      // 对于周间隔，需要确保偏移后仍然对齐到 ISO 周的开始（周一）
      // 使用 7 * week 来进行天数偏移，确保 TRUNC(..., 'IW') 能正确对齐
      const weekDays = intervalParsed.week * 7;
      res = `${res} - ${weekDays}`;
    }

    if (intervalParsed.day) {
      if (DmQuery.dmUseNumericDayArithmetic(intervalParsed)) {
        res = `${res} - ${intervalParsed.day}`;
      } else {
        res = `${res} - NUMTODSINTERVAL(${intervalParsed.day}, 'DAY')`;
      }
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

  /** 达梦生成的短表别名格式（DM_+hash，可能大小写），用于 escapeColumnName 中判断是否不加重引号 */
  private static readonly DM_SHORT_ALIAS_REGEX = /^DM_[A-Z0-9]+$/i;
  /**
   * 达梦中部分关键字（如 USER）作为表名时必须加双引号，否则会被解析为关键字。
   * 这里仅对「纯标识符」或「schema.table」这种简单形式做安全加引号，
   * 子查询/复杂表达式（包含空白、括号等）保持原样。
   */
  private escapeTableNameIfNeeded(tableSql: string): string {
    if (!tableSql) {
      return tableSql;
    }

    const trimmed = String(tableSql).trim();
    // 已包含引号/括号/空白/SQL 关键结构时，视为复杂表达式，保持不变
    if (/[()\s]/.test(trimmed) || trimmed.includes('"')) {
      return tableSql;
    }

    const identifierPart = /^[A-Za-z_][A-Za-z0-9_$#]*$/;
    const parts = trimmed.split('.');
    if (!parts.length || !parts.every((p) => identifierPart.test(p))) {
      return tableSql;
    }

    const quote = (p: string) => `"${p.replace(/"/g, '""')}"`;
    return parts.map(quote).join('.');
  }

  private static timeSeriesLiteralCast(isoTimestamp: string): string {
    return `CAST(TO_TIMESTAMP_TZ('${isoTimestamp}', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"') AS TIMESTAMP)`;
  }

  /** Tesseract 自定义粒度 rolling window 也走 generated time series。 */
  public supportGeneratedSeriesForCustomTd(): boolean {
    return true;
  }

  /**
   * 达梦 RECURSIVE WITH 受 CTE_MAXRECURSION 限制；在业务 CTE 上 CONNECT BY 会触发 -4030 循环检测。
   * 仅在 DUAL 上 CONNECT BY 生成 LEVEL，再 CROSS JOIN bounds（Oracle 标准写法）。
   *
   * ADD_MONTHS 必须作用在 DATE 上再 CAST 为 TIMESTAMP；直接对 TIMESTAMP 做 ADD_MONTHS 后减 NUMTODSINTERVAL
   * 会在 rolling join 中与 TRUNC(..., 'MM') 的 DATE 比较时触发 DM [-6105] 数据类型不匹配。
   */
  private static generatedTimeSeriesDateAnchor(column: string): string {
    return `CAST(${column} AS DATE)`;
  }

  private static generatedTimeSeriesTimestampAnchor(column: string): string {
    return `CAST(CAST(${column} AS DATE) AS TIMESTAMP)`;
  }

  private static generatedTimeSeriesDateFromAtLevel(
    anchorDate: string,
    anchorTs: string,
    levelExpr = 'LEVEL',
  ): string {
    return '{% set g = granularity | replace("\'", "") | trim %}'
      + `{% if g == '1 second' %}${anchorTs} + NUMTODSINTERVAL(${levelExpr} - 1, 'SECOND')`
      + `{% elif g == '1 minute' %}${anchorTs} + NUMTODSINTERVAL(${levelExpr} - 1, 'MINUTE')`
      + `{% elif g == '1 hour' %}${anchorTs} + NUMTODSINTERVAL(${levelExpr} - 1, 'HOUR')`
      + `{% elif g == '1 day' %}${anchorTs} + NUMTODSINTERVAL(${levelExpr} - 1, 'DAY')`
      + `{% elif g == '1 week' %}${anchorTs} + NUMTODSINTERVAL((${levelExpr} - 1) * 7, 'DAY')`
      + `{% elif g == '1 month' %}CAST(ADD_MONTHS(${anchorDate}, ${levelExpr} - 1) AS TIMESTAMP)`
      + `{% elif g == '3 month' %}CAST(ADD_MONTHS(${anchorDate}, (${levelExpr} - 1) * 3) AS TIMESTAMP)`
      + `{% elif g == '1 quarter' %}CAST(ADD_MONTHS(${anchorDate}, (${levelExpr} - 1) * 3) AS TIMESTAMP)`
      + `{% elif g == '1 year' %}CAST(ADD_MONTHS(${anchorDate}, (${levelExpr} - 1) * 12) AS TIMESTAMP)`
      + `{% else %}${anchorTs} + NUMTODSINTERVAL(${levelExpr} - 1, 'DAY'){% endif %}`;
  }

  private static generatedTimeSeriesDateToAtLevel(
    anchorDate: string,
    anchorTs: string,
    levelExpr = 'LEVEL',
  ): string {
    return '{% set g = granularity | replace("\'", "") | trim %}'
      + `{% if g == '1 second' %}${anchorTs} + NUMTODSINTERVAL(${levelExpr}, 'SECOND') - NUMTODSINTERVAL(1, 'SECOND')`
      + `{% elif g == '1 minute' %}${anchorTs} + NUMTODSINTERVAL(${levelExpr}, 'MINUTE') - NUMTODSINTERVAL(1, 'SECOND')`
      + `{% elif g == '1 hour' %}${anchorTs} + NUMTODSINTERVAL(${levelExpr}, 'HOUR') - NUMTODSINTERVAL(1, 'SECOND')`
      + `{% elif g == '1 day' %}${anchorTs} + NUMTODSINTERVAL(${levelExpr}, 'DAY') - NUMTODSINTERVAL(1, 'SECOND')`
      + `{% elif g == '1 week' %}${anchorTs} + NUMTODSINTERVAL(${levelExpr} * 7, 'DAY') - NUMTODSINTERVAL(1, 'SECOND')`
      + `{% elif g == '1 month' %}CAST(ADD_MONTHS(${anchorDate}, ${levelExpr}) AS TIMESTAMP) - NUMTODSINTERVAL(1, 'SECOND')`
      + `{% elif g == '3 month' %}CAST(ADD_MONTHS(${anchorDate}, ${levelExpr} * 3) AS TIMESTAMP) - NUMTODSINTERVAL(1, 'SECOND')`
      + `{% elif g == '1 quarter' %}CAST(ADD_MONTHS(${anchorDate}, ${levelExpr} * 3) AS TIMESTAMP) - NUMTODSINTERVAL(1, 'SECOND')`
      + `{% elif g == '1 year' %}CAST(ADD_MONTHS(${anchorDate}, ${levelExpr} * 12) AS TIMESTAMP) - NUMTODSINTERVAL(1, 'SECOND')`
      + `{% else %}${anchorTs} + NUMTODSINTERVAL(${levelExpr}, 'DAY') - NUMTODSINTERVAL(1, 'SECOND'){% endif %}`;
  }

  private static generatedTimeSeriesConnectByLevelLimit(minCol: string, maxCol: string): string {
    const minDate = `CAST(${minCol} AS DATE)`;
    const maxDate = `CAST(${maxCol} AS DATE)`;
    return '{% set g = granularity | replace("\'", "") | trim %}'
      + `{% if g == '1 week' %}TRUNC((${maxDate} - ${minDate} + 7) / 7)`
      + `{% elif g == '1 month' %}FLOOR(MONTHS_BETWEEN(${maxDate}, ${minDate})) + 1`
      + `{% elif g == '3 month' %}FLOOR(MONTHS_BETWEEN(${maxDate}, ${minDate}) / 3) + 1`
      + `{% elif g == '1 quarter' %}FLOOR(MONTHS_BETWEEN(${maxDate}, ${minDate}) / 3) + 1`
      + `{% elif g == '1 year' %}FLOOR(MONTHS_BETWEEN(${maxDate}, ${minDate}) / 12) + 1`
      + `{% elif g == '1 hour' %}(${maxDate} - ${minDate} + 1) * 24`
      + `{% else %}(${maxDate} - ${minDate} + 1){% endif %}`;
  }

  /** CONNECT BY 只作用于 DUAL，避免达梦 -4030「用户数据中的 CONNECT BY 循环」。 */
  private static generatedTimeSeriesDualLevelJoin(levelLimitSql: string): string {
    return 'CROSS JOIN (\n'
      + '  SELECT LEVEL AS lv\n'
      + '  FROM DUAL\n'
      + `  CONNECT BY LEVEL <= ${levelLimitSql}\n`
      + ') gen';
  }

  private static generatedTimeSeriesSelectTemplate(): string {
    const anchorDate = DmQuery.generatedTimeSeriesDateAnchor('{{ start }}');
    const anchorTs = DmQuery.generatedTimeSeriesTimestampAnchor('{{ start }}');
    const levelLimit = DmQuery.generatedTimeSeriesConnectByLevelLimit('{{ start }}', '{{ end }}');
    return 'SELECT\n'
      + `  ${DmQuery.generatedTimeSeriesDateFromAtLevel(anchorDate, anchorTs, 'gen.lv')} AS "date_from",\n`
      + `  ${DmQuery.generatedTimeSeriesDateToAtLevel(anchorDate, anchorTs, 'gen.lv')} AS "date_to"\n`
      + 'FROM DUAL\n'
      + `${DmQuery.generatedTimeSeriesDualLevelJoin(levelLimit)}`;
  }

  private static generatedTimeSeriesWithCteRangeSourceTemplate(): string {
    const boundsMin = 'bounds."{{ min_name }}"';
    const anchorDate = DmQuery.generatedTimeSeriesDateAnchor(boundsMin);
    const anchorTs = DmQuery.generatedTimeSeriesTimestampAnchor(boundsMin);
    const levelLimit = `(\n`
      + '    SELECT '
      + `${DmQuery.generatedTimeSeriesConnectByLevelLimit('{{ range_source }}.{{ min_name }}', '{{ range_source }}.{{ max_name }}')}\n`
      + '    FROM {{ range_source }}\n'
      + '  )';
    return 'SELECT\n'
      + `  ${DmQuery.generatedTimeSeriesDateFromAtLevel(anchorDate, anchorTs, 'gen.lv')} AS "date_from",\n`
      + `  ${DmQuery.generatedTimeSeriesDateToAtLevel(anchorDate, anchorTs, 'gen.lv')} AS "date_to"\n`
      + 'FROM (\n'
      + '  SELECT {{ range_source }}.{{ min_name }} AS "{{ min_name }}", {{ range_source }}.{{ max_name }} AS "{{ max_name }}"\n'
      + '  FROM {{ range_source }}\n'
      + ') bounds\n'
      + `${DmQuery.generatedTimeSeriesDualLevelJoin(levelLimit)}`;
  }

  /**
   * 达梦不支持 `FROM (VALUES ...) AS t` 语法；与 Oracle 一样用 UNION ALL + DUAL 生成时间序列。
   */
  public override seriesSql(timeDimension) {
    const rows = timeDimension.timeSeries().map(
      ([from, to]) => `SELECT ${DmQuery.timeSeriesLiteralCast(from)} as ${this.escapeColumnName('date_from')}, ${DmQuery.timeSeriesLiteralCast(to)} as ${this.escapeColumnName('date_to')} FROM DUAL`,
    );
    return rows.join(' UNION ALL ');
  }

  public sqlTemplates() {
    const templates = super.sqlTemplates();
    // 达梦不支持 PERCENTILE_CONT 生成的语句类型，中位数走应用层或其它实现
    delete templates.functions.PERCENTILECONT;
    // 达梦对 FULL JOIN 有限制（仅合并/哈希连接场景），与 MySQL 一样禁用 FULL OUTER JOIN，
    // 让 Tesseract 走 KeysFullKeyAggregateStrategy（LEFT JOIN 链）而非 FullJoin 策略。
    delete templates.join_types.full;
    if (templates.tesseract?.join_types_full) {
      delete templates.tesseract.join_types_full;
    }
    // Tesseract 默认 GROUP BY/ORDER BY 使用列序号（1,2,3），达梦不支持，改用完整列表达式（同 MssqlQuery）
    templates.statements.group_by_exprs = '{{ group_by | map(attribute=\'expr\') | join(\', \') }}';
    templates.expressions.order_by = '{{ expr }} {% if asc %}ASC NULLS FIRST{% else %}DESC NULLS LAST{% endif %}';
    // Tesseract：DM 不支持 VALUES 行构造器，改用 UNION ALL ... FROM DUAL
    templates.statements.time_series_select = '{% for time_item in seria %}'
      + 'SELECT CAST(TO_TIMESTAMP_TZ(\'{{ time_item[0] }}\', \'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"\') AS TIMESTAMP) AS "date_from", '
      + 'CAST(TO_TIMESTAMP_TZ(\'{{ time_item[1] }}\', \'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"\') AS TIMESTAMP) AS "date_to" FROM DUAL'
      + '{% if not loop.last %} UNION ALL {% endif %}'
      + '{% endfor %}';
    templates.statements.generated_time_series_select = DmQuery.generatedTimeSeriesSelectTemplate();
    templates.statements.generated_time_series_with_cte_range_source =
      DmQuery.generatedTimeSeriesWithCteRangeSourceTemplate();
    return templates;
  }

  /**
   * 达梦在解析「"别名".列名」或小写别名.列名 时报「无法解析的成员访问表达式」。
   * 未加引号时达梦将标识符转为大写，故短别名用 DM_+hash 并全大写，与引用处一致。
   */
  public cubeAlias(cubeName: string): string {
    const alias = super.cubeAlias(cubeName);
    const inner = alias.replace(/^"|"$/g, '');
    if (inner.length <= DM_MAX_ALIAS_LENGTH) {
      return inner;
    }
    const short = `DM_${Math.abs(simpleHash(cubeName)).toString(36).toUpperCase().slice(0, DM_MAX_ALIAS_LENGTH - 3)}`;
    return short;
  }

  /**
   * 达梦不接受「"表别名".列名」，表别名在别处会被再次 escapeColumnName 导致加引号。
   * 对 cubeAlias 生成的短别名（DM_xxx 大写）不再加引号。
   */
  public escapeColumnName(name: string): string {
    if (DmQuery.DM_SHORT_ALIAS_REGEX.test(name)) {
      return name;
    }
    return super.escapeColumnName(name);
  }

  public cubeSql(cube: string): string {
    // 先走基类逻辑（含预聚合、select * from 识别等），再对简单表名做一次安全加引号
    return this.escapeTableNameIfNeeded(super.cubeSql(cube));
  }

  /**
   * 达梦在 LEFT JOIN (子查询) 别名 ON 别名.列 中报「无法解析的成员访问表达式」；
   * 改用 WITH 别名 AS (子查询) SELECT ... LEFT JOIN 别名 ON ...。
   * 达梦对带下划线的 CTE 名（如 DM_33OHZG）仍报错，故此处固定使用简单名 DM_BASE，并在条件中替换原别名。
   */
  public overTimeSeriesSelect(
    cumulativeMeasures: unknown[],
    dateSeriesSql: string,
    baseQuery: string,
    dateJoinConditionSql: string,
    baseQueryAlias: string,
    dateSeriesGranularity?: string
  ): string {
    const forSelect = this.overTimeSeriesForSelect(cumulativeMeasures, dateSeriesGranularity);
    const cteName = 'DM_BASE';
    const safeAlias = baseQueryAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const conditionSql = baseQueryAlias === cteName
      ? dateJoinConditionSql
      : dateJoinConditionSql.replace(new RegExp(safeAlias, 'g'), cteName);
    return `WITH ${cteName} AS (${baseQuery}) SELECT ${forSelect} FROM ${dateSeriesSql}` +
      ` LEFT JOIN ${cteName} ON ${conditionSql}` +
      this.groupByClause();
  }

  public timeGroupedColumn(granularity, dimension) {
    if (!granularity) {
      return dimension;
    }
    if (granularity === 'second') {
      // DM: TRUNC(date, 'ss') 会报「无效的时间格式掩码」，用“格式化到秒再解析”实现秒级截断
      return `TO_DATE(TO_CHAR(${dimension}, 'YYYY-MM-DD HH24:MI:SS'), 'YYYY-MM-DD HH24:MI:SS')`;
    }
    return `CAST(TRUNC(${dimension}, '${GRANULARITY_VALUE[granularity]}') AS TIMESTAMP)`;
  }
  public supportsFilterClause() {
    return true;
  }

  /**
   * 达梦不允许在 CTE / 子查询的 FROM 源（`(cte_0 FETCH …)`、逗号 JOIN 尾部的 FETCH 等）上使用 FETCH。
   * multi-stage 中间层由 renderWithQuery 创建并标记 disableExternalPreAggregations，此处跳过 row limit。
   * 最外层查询仍保留 FETCH NEXT，与用户 limit 一致。
   */
  public override groupByDimensionLimit() {
    if (this.options.disableExternalPreAggregations) {
      return '';
    }
    return super.groupByDimensionLimit();
  }

  // ==========================================================================
  // period_average 方言适配区（达梦 DM）
  //
  // 下面方法均是对 BaseQuery 中 PostgreSQL 风格默认实现的重写，将日期/时间函数
  // 替换为达梦语法（基本与 Oracle 一致，差异见各方法注释）。适配新数据库时，
  // 参照本区块重写下列方法（详见 BaseQuery 中各方法的 @dialect 注释）：
  //   - periodAverageDateLiteral / periodAverageToDateExpr  日期字面量与转 DATE
  //   - periodAverageNowExpr             当前日期（注意：用 SYSDATE，DB 服务器时区）
  //   - periodAverageGroupedBucketExpr   窗口列 MIN 包装
  //   - periodAverageClosedFormIntervalBucketUnits  整区间 calendar 快路径（先 super）
  //   - periodAverageCumulativeCalendarUnitCount    累计 calendar 快路径（先 super）
  //   - periodAverageDaysIn{Month,Quarter,Year}Bucket  桶内天数
  //   - periodAverageBucketEndExpr       区间终点
  //   - periodAverageIntervalStartExpr   区间起点
  //   - periodAverageIntervalBucketFromAvgUnit  从 avg_unit 列推区间桶（注意 DM 用 TIMESTAMP）
  //   - {days,months,quarters,years}BetweenInclusive  间隔计数（MONTHS_BETWEEN）
  // ==========================================================================

  periodAverageDateLiteral(dateStr: string): string {
    const dateOnly = String(dateStr).slice(0, 10);
    return `CAST('${dateOnly}' AS DATE)`;
  }

  periodAverageNowExpr(): string {
    const frozenNow = process.env.CUBEJS_TEST_NOW;
    if (frozenNow) {
      return this.periodAverageDateLiteral(frozenNow);
    }
    return 'CAST(SYSDATE AS DATE)';
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
        return `CAST(TRUNC(CAST(${avgUnitBucket} AS DATE), 'MM') AS TIMESTAMP)`;
      case 'quarter':
        return `CAST(TRUNC(CAST(${avgUnitBucket} AS DATE), 'Q') AS TIMESTAMP)`;
      case 'year':
        return `CAST(TRUNC(CAST(${avgUnitBucket} AS DATE), 'YYYY') AS TIMESTAMP)`;
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

  // 达梦 DDL 为引号小写，与 Postgres 相同：`"cube"."col"` 与 `cube.col`，
  // 与 BaseQuery 默认实现一致，无需 override。
}
