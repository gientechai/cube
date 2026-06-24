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
 */
import { parseSqlInterval } from '@cubejs-backend/shared';
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
   * Tesseract rolling window on DM requires dateRange on timeDimensions (no generate_series fallback).
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
    return `TRUNC(${dimension}, '${GRANULARITY_VALUE[granularity]}')`;
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
}
