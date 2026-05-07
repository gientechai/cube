/**
 * 达梦 (DM) 数据库查询适配：继承 OracleQuery。
 *
 * 从 OracleQuery 继承的、与达梦兼容的行为（不改动 OracleQuery 的 Oracle 语义）：
 * - seriesSql：running total 使用 UNION ALL SELECT ... FROM DUAL（Oracle 同款，达梦复用）。
 * - preAggregationTableName：default schema 加双引号、表名长度限制（Oracle 同款，达梦复用）。
 * - cubeAlias：表别名中 "default" 替换为 "ds_default"（Oracle 同款，达梦复用）。
 *
 * 本文件内达梦专属逻辑：
 * - sqlTemplates：禁用 PERCENTILE_CONT（达梦报「不支持的语句类型」）。
 * - cubeAlias：对 DM 返回无引号短别名（≤30 字节），避免「无法解析的成员访问表达式」。
 * - escapeColumnName：对 DM_xxx 短别名不再加引号。
 * - overTimeSeriesSelect：用 WITH DM_BASE AS (...) 替代子查询别名，避免达梦解析错误。
 */
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
export class DmQuery extends OracleQuery {
  constructor(compilers, options) {
    super(compilers, options);
    // Native SQL planner generates GROUP BY 1,2,3; Oracle requires column expressions.
    this.useNativeSqlPlanner = false;
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

  public sqlTemplates() {
    const templates = super.sqlTemplates();
    // 达梦不支持 PERCENTILE_CONT 生成的语句类型，中位数走应用层或其它实现
    delete templates.functions.PERCENTILECONT;
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
}
