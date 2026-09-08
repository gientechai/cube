/**
 * GBase 8a query adapter.
 *
 * GBase does not support `@@session.time_zone` (rewritten to missing
 * `get_system_var()` on gnode). Session timezone is set to UTC in
 * `@cubejs-backend/gbase-driver`; use that literal in SQL instead.
 *
 * Additional GBase MPP constraints handled here:
 * - No nested `WITH RECURSIVE` inside outer CTE bodies → digits CROSS JOIN time series
 * - No ORDER BY aggregate alias on grouped outer queries → repeat measureSql for PA data path
 * - Temp-table materialization truncates long identifiers (64 bytes) → `pa_b_<measure>` prefix
 * - Tesseract top-level multi-CTE rolling/time_shift SQL is rejected by gcluster → JS planner
 * - Ungrouped measure filters via HAVING → outer WHERE wrapper
 * - Semi-additive q_0 / CTE 中间层不得叠加 LIMIT/OFFSET
 */
import { BaseMeasure } from './BaseMeasure';
import { BaseTimeDimension } from './BaseTimeDimension';
import { MysqlQuery } from './MysqlQuery';

const SESSION_TIMEZONE_PATTERN = /@@session\.time_zone/gi;

const DIGITS_0_TO_9 = '(SELECT 0 AS i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)';

export class GBaseQuery extends MysqlQuery {
  private sessionTimezoneLiteral(): string {
    return "'+00:00'";
  }

  private withoutSessionTimeZone(sql: string): string {
    return sql.replace(SESSION_TIMEZONE_PATTERN, this.sessionTimezoneLiteral());
  }

  public convertTz(field: string) {
    return this.withoutSessionTimeZone(super.convertTz(field));
  }

  public timeStampCast(value: string) {
    return this.withoutSessionTimeZone(super.timeStampCast(value));
  }

  /**
   * GBase MPP 在半累加 CTE / q_0 中间层上执行 LIMIT 会导致结果集截断为 1 行。
   * 与 {@link DmQuery#groupByDimensionLimit} 相同：仅最外层保留 rowLimit。
   */
  public override groupByDimensionLimit() {
    if (this.options.disableExternalPreAggregations) {
      return '';
    }
    return super.groupByDimensionLimit();
  }

  /**
   * GBase 物化 CTE 为临时表时，`__pa_base_*` 限定名解析失败，且标识符上限 64 字节。
   * 使用短前缀 + measure 短名（不含 cube 前缀），例如 `pa_b_period_daily_avg_calendar`。
   */
  public override periodAverageSemiAdditiveBaseColumnAlias(measure: BaseMeasure) {
    const fullAlias = measure.unescapedAliasName();
    const shortName = fullAlias.includes('__')
      ? fullAlias.split('__').pop() || fullAlias
      : fullAlias;
    return this.escapeColumnName(`pa_b_${shortName}`);
  }

  /**
   * GBase gcluster 不支持 Tesseract 生成的顶层多 CTE rolling/time_shift SQL
   * （GBA-02SC-1001），回退 JS 生成器（嵌套子查询 + UNION 时间轴）。
   */
  private shouldFallbackFromNativeSqlPlannerForGBase(): boolean {
    if (this.cumulativeMeasures().length > 0) {
      return true;
    }
    if (this.multiStageQuery) {
      return true;
    }
    return this.collectAllMemberNames().some((memberName) => {
      const leaf = String(memberName).split('.').pop() || '';
      return leaf.includes('_lastYear')
        || leaf.includes('_lastMonth')
        || leaf.includes('_mom_')
        || leaf.includes('_yoy_')
        || leaf.includes('_to_date');
    });
  }

  /**
   * MysqlQuery.groupByClause() 在 rollingWindow 外层会引用 cumulative 子查询别名，
   * GBase 上改为按 time_series.date_from（与 SELECT 列一致）分组。
   */
  public override overTimeSeriesSelect(
    cumulativeMeasures: BaseMeasure[],
    dateSeriesSql: string,
    baseQuery: string,
    dateJoinConditionSql: string,
    baseQueryAlias: string,
    dateSeriesGranularity: string,
  ): string {
    const forSelect = this.overTimeSeriesForSelect(cumulativeMeasures, dateSeriesGranularity);
    const groupByParts: string[] = [];

    for (const dimension of this.dimensions) {
      for (const col of dimension.cumulativeSelectColumns()) {
        if (col) {
          groupByParts.push(col.trim());
        }
      }
    }

    for (const td of this.timeDimensions.filter((d) => d.granularity)) {
      groupByParts.push(
        `${td.dateSeriesAliasName()}.${this.escapeColumnName('date_from')}`,
      );
    }

    const groupBy = groupByParts.length ? ` GROUP BY ${groupByParts.join(', ')}` : '';
    return `SELECT ${forSelect} FROM ${dateSeriesSql}`
      + ` LEFT JOIN (${baseQuery}) ${this.asSyntaxJoin} ${baseQueryAlias} ON ${dateJoinConditionSql}`
      + groupBy;
  }

  /**
   * GBase 不允许在外层 GROUP BY 查询中按聚合别名 ORDER BY（ER_ILLEGAL_REFERENCE）。
   * period_avg_data_daily 路径下外层仅暴露 CTE 列，重复 measureSql() 安全。
   */
  public override getFieldOrderExpr(id: string) {
    const equalIgnoreCase = (a: string, b: string) => (
      typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase()
    );

    const measure = this.measures.find(
      (d) => equalIgnoreCase(d.measure, id) || equalIgnoreCase(d.expressionName, id),
    );

    if (
      measure
      && this.isPeriodAverageMeasure(measure)
      && this.shouldUsePeriodAverageDataPreAggregatePath()
    ) {
      return this.periodAverageDataPreAggregateOuterMeasureSql(measure);
    }

    return super.getFieldOrderExpr(id);
  }

  /**
   * Tesseract 对 GBase 的无维度 measure filter 仍生成 HAVING；强制走 JS + baseHaving 包装。
   */
  public override buildSqlAndParams(exportAnnotatedSql?: boolean) {
    const hasTimeGranularity = (this.timeDimensions || []).some((td) => td.granularity);
    if (this.useNativeSqlPlanner) {
      if (
        this.measureFilters?.length
        && !this.hasPeriodAverageMeasureFilters()
        && !this.dimensions.length
        && !hasTimeGranularity
      ) {
        return this.newQueryWithoutNative().buildSqlAndParams(exportAnnotatedSql);
      }
      if (this.shouldFallbackFromNativeSqlPlannerForGBase()) {
        return this.newQueryWithoutNative().buildSqlAndParams(exportAnnotatedSql);
      }
    }
    return super.buildSqlAndParams(exportAnnotatedSql);
  }

  /**
   * GBase 不支持无 GROUP BY 的 HAVING（总计 + measure filter、RBAC 场景）。
   * 改走外层子查询 WHERE，与 period_average measure filter 包装一致。
   */
  public override baseHaving(query: string, filters: unknown[]) {
    if (!filters?.length || this.hasPeriodAverageMeasureFilters()) {
      return super.baseHaving(query, filters);
    }
    const hasGroupBy = /\bGROUP BY\b/i.test(query);
    if (!hasGroupBy) {
      const columns = this.measures
        .map((m) => m.aliasName())
        .filter(Boolean);
      return this.wrapWithOuterMeasureFilters(query, columns);
    }
    return super.baseHaving(query, filters);
  }

  /**
   * 测试模型里 to_date 指标带 multi_stage:true（为 Tesseract 准备），但 GBase JS 路径会因此
   * 走 WITH multi_stage 而非 overTimeSeries，导致累计窗口错误。对 rollingWindow to_date
   * 临时忽略 multi_stage，复用 overTimeSeries + FROM DUAL 时间轴。
   */
  private isRollingToDateMultiStageMeasure(measurePath: string): boolean {
    try {
      const def = this.cubeEvaluator.measureByPath(measurePath);
      return Boolean(def?.multiStage && def?.rollingWindow?.type === 'to_date');
    } catch {
      return false;
    }
  }

  public override fullKeyQueryAggregateMeasures(context?: unknown) {
    const restores: Array<() => void> = [];
    for (const measure of this.measures) {
      if (!this.isRollingToDateMultiStageMeasure(measure.measure)) {
        continue;
      }
      const definition = measure.measureDefinition();
      if (definition?.multiStage) {
        definition.multiStage = false;
        restores.push(() => {
          definition.multiStage = true;
        });
      }
    }
    try {
      return super.fullKeyQueryAggregateMeasures(context);
    } finally {
      restores.forEach((restore) => restore());
    }
  }

  public override supportGeneratedSeriesForCustomTd(): boolean {
    return true;
  }

  /**
   * GBase gcluster 不支持 `(select '...' f union all select ...)` 无 DUAL 的派生表；
   * 与达梦相同，用 `SELECT ... FROM DUAL UNION ALL ...` 生成时间轴。
   */
  public override seriesSql(timeDimension: BaseTimeDimension): string {
    const rows = timeDimension.timeSeries().map(
      ([from, to]) => (
        `SELECT TIMESTAMP('${from}') AS ${this.escapeColumnName('date_from')}, `
        + `TIMESTAMP('${to}') AS ${this.escapeColumnName('date_to')} FROM DUAL`
      ),
    );
    return rows.join(' UNION ALL ');
  }

  private static generatedTimeSeriesDateAnchor(column: string): string {
    return `CAST(${column} AS DATETIME)`;
  }

  private static levelExpr(): string {
    return 'nums.seq';
  }

  private static generatedTimeSeriesDateFromAtLevel(anchor: string): string {
    const levelExpr = GBaseQuery.levelExpr();
    return '{% set g = granularity | replace("\'", "") | trim | lower %}'
      + `{% if g == '1 second' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) SECOND)`
      + `{% elif g == '1 minute' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) MINUTE)`
      + `{% elif g == '1 hour' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) HOUR)`
      + `{% elif g == '1 day' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) DAY)`
      + `{% elif g == '1 week' %}DATE_ADD(${anchor}, INTERVAL ((${levelExpr} - 1) * 7) DAY)`
      + `{% elif g == '1 month' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) MONTH)`
      + `{% elif g == '3 month' %}DATE_ADD(${anchor}, INTERVAL ((${levelExpr} - 1) * 3) MONTH)`
      + `{% elif g == '1 quarter' %}DATE_ADD(${anchor}, INTERVAL ((${levelExpr} - 1) * 3) MONTH)`
      + `{% elif g == '1 year' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) YEAR)`
      + `{% else %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) DAY){% endif %}`;
  }

  private static generatedTimeSeriesDateToAtLevel(anchor: string): string {
    const levelExpr = GBaseQuery.levelExpr();
    return '{% set g = granularity | replace("\'", "") | trim | lower %}'
      + `{% if g == '1 second' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} SECOND), INTERVAL 1 SECOND)`
      + `{% elif g == '1 minute' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} MINUTE), INTERVAL 1 SECOND)`
      + `{% elif g == '1 hour' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} HOUR), INTERVAL 1 SECOND)`
      + `{% elif g == '1 day' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} DAY), INTERVAL 1 SECOND)`
      + `{% elif g == '1 week' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL (${levelExpr} * 7) DAY), INTERVAL 1 SECOND)`
      + `{% elif g == '1 month' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} MONTH), INTERVAL 1 SECOND)`
      + `{% elif g == '3 month' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL (${levelExpr} * 3) MONTH), INTERVAL 1 SECOND)`
      + `{% elif g == '1 quarter' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL (${levelExpr} * 3) MONTH), INTERVAL 1 SECOND)`
      + `{% elif g == '1 year' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} YEAR), INTERVAL 1 SECOND)`
      + `{% else %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} DAY), INTERVAL 1 SECOND){% endif %}`;
  }

  private static generatedTimeSeriesLevelLimit(minCol: string, maxCol: string): string {
    const minTs = `CAST(${minCol} AS DATETIME)`;
    const maxTs = `CAST(${maxCol} AS DATETIME)`;
    return '{% set g = granularity | replace("\'", "") | trim | lower %}'
      + `{% if g == '1 second' %}TIMESTAMPDIFF(SECOND, ${minTs}, ${maxTs}) + 1`
      + `{% elif g == '1 minute' %}TIMESTAMPDIFF(MINUTE, ${minTs}, ${maxTs}) + 1`
      + `{% elif g == '1 hour' %}TIMESTAMPDIFF(HOUR, ${minTs}, ${maxTs}) + 1`
      + `{% elif g == '1 day' %}DATEDIFF(${maxTs}, ${minTs}) + 1`
      + `{% elif g == '1 week' %}FLOOR(DATEDIFF(${maxTs}, ${minTs}) / 7) + 1`
      + `{% elif g == '1 month' %}TIMESTAMPDIFF(MONTH, ${minTs}, ${maxTs}) + 1`
      + `{% elif g == '3 month' %}FLOOR(TIMESTAMPDIFF(MONTH, ${minTs}, ${maxTs}) / 3) + 1`
      + `{% elif g == '1 quarter' %}FLOOR(TIMESTAMPDIFF(MONTH, ${minTs}, ${maxTs}) / 3) + 1`
      + `{% elif g == '1 year' %}TIMESTAMPDIFF(YEAR, ${minTs}, ${maxTs}) + 1`
      + `{% else %}DATEDIFF(${maxTs}, ${minTs}) + 1{% endif %}`;
  }

  /**
   * GBase 不允许 `time_series AS ( WITH RECURSIVE ... )` 嵌套写法。
   * 用 0–9999 数字表 CROSS JOIN 代替 RECURSIVE CTE（可嵌入外层 WITH）。
   */
  private static generatedTimeSeriesSeriesJoinFromBounds(levelLimitSql: string): string {
    return 'CROSS JOIN (\n'
      + '  SELECT (a.i + b.i * 10 + c.i * 100 + d.i * 1000) AS seq\n'
      + '  FROM\n'
      + `    ${DIGITS_0_TO_9} a\n`
      + `    CROSS JOIN ${DIGITS_0_TO_9} b\n`
      + `    CROSS JOIN ${DIGITS_0_TO_9} c\n`
      + `    CROSS JOIN ${DIGITS_0_TO_9} d\n`
      + ') nums\n'
      + `WHERE nums.seq <= (${levelLimitSql})`;
  }

  private static generatedTimeSeriesSelectTemplate(): string {
    const anchor = GBaseQuery.generatedTimeSeriesDateAnchor('bounds.min_date');
    const levelLimit = GBaseQuery.generatedTimeSeriesLevelLimit('bounds.min_date', 'bounds.max_date');
    return 'SELECT\n'
      + `  ${GBaseQuery.generatedTimeSeriesDateFromAtLevel(anchor)} AS date_from,\n`
      + `  ${GBaseQuery.generatedTimeSeriesDateToAtLevel(anchor)} AS date_to\n`
      + 'FROM (\n'
      + '  SELECT TIMESTAMP({{ start }}) AS min_date, TIMESTAMP({{ end }}) AS max_date\n'
      + ') bounds\n'
      + `${GBaseQuery.generatedTimeSeriesSeriesJoinFromBounds(levelLimit)}`;
  }

  private static generatedTimeSeriesWithCteRangeSourceTemplate(): string {
    const anchor = GBaseQuery.generatedTimeSeriesDateAnchor('bounds.{{ min_name }}');
    const levelLimit = GBaseQuery.generatedTimeSeriesLevelLimit(
      'bounds.{{ min_name }}',
      'bounds.{{ max_name }}',
    );
    return 'SELECT\n'
      + `  ${GBaseQuery.generatedTimeSeriesDateFromAtLevel(anchor)} AS date_from,\n`
      + `  ${GBaseQuery.generatedTimeSeriesDateToAtLevel(anchor)} AS date_to\n`
      + 'FROM (\n'
      + '  SELECT {{ range_source }}.{{ min_name }} AS {{ min_name }}, {{ range_source }}.{{ max_name }} AS {{ max_name }}\n'
      + '  FROM {{ range_source }}\n'
      + ') bounds\n'
      + `${GBaseQuery.generatedTimeSeriesSeriesJoinFromBounds(levelLimit)}`;
  }

  public override sqlTemplates() {
    const templates = super.sqlTemplates();
    delete templates.join_types.full;
    if (templates.tesseract?.join_types_full) {
      delete templates.tesseract.join_types_full;
    }
    templates.statements.generated_time_series_select =
      GBaseQuery.generatedTimeSeriesSelectTemplate();
    templates.statements.generated_time_series_with_cte_range_source =
      GBaseQuery.generatedTimeSeriesWithCteRangeSourceTemplate();
    return templates;
  }
}
