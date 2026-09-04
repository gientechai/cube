/**
 * StarRocks query adapter.
 *
 * StarRocks is MySQL-compatible for most dialect surface, but:
 * - generated time series must use generate_series (not MySQL WITH RECURSIVE)
 * - time bucketing should use date_trunc (avoid DATE_FORMAT + ISO `T` + CAST chains)
 * - timestamp literals prefer space-separated DATETIME (safer than `...T...` casts)
 *
 * TABLE(generate_series(...)) is only for constant bounds; column/expression bounds
 * use comma-join generate_series without TABLE() (StarRocks docs).
 */
import { MysqlQuery } from './MysqlQuery';

const STARROCKS_DATE_TRUNC_GRANULARITY: Record<string, string> = {
  second: 'second',
  minute: 'minute',
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
  quarter: 'quarter',
  year: 'year',
};

export class StarRocksQuery extends MysqlQuery {
  public supportGeneratedSeriesForCustomTd(): boolean {
    return true;
  }

  /**
   * Prefer space-separated timestamps so CAST/TIMESTAMP parsing does not depend on
   * ISO-8601 `T` support across StarRocks versions.
   */
  public timestampFormat(): string {
    // Space-separated (no ISO `T`) — safer across StarRocks CAST/TIMESTAMP parsers.
    return 'YYYY-MM-DD HH:mm:ss.SSS';
  }

  public dateTimeCast(value: string): string {
    return `CAST(${value} AS DATETIME)`;
  }

  public timeStampCast(value: string): string {
    // Keep CONVERT_TZ semantics from MysqlQuery, but cast explicitly to DATETIME.
    return `CAST(CONVERT_TZ(${value}, '+00:00', @@session.time_zone) AS DATETIME)`;
  }

  public timeGroupedColumn(granularity: string, dimension: string): string {
    const unit = STARROCKS_DATE_TRUNC_GRANULARITY[granularity];
    if (!unit) {
      return super.timeGroupedColumn(granularity, dimension);
    }
    return `date_trunc('${unit}', ${dimension})`;
  }

  private static generatedTimeSeriesDateAnchor(column: string): string {
    return `CAST(${column} AS DATETIME)`;
  }

  private static levelExpr(alias = 'gen'): string {
    return `${alias}.generate_series`;
  }

  private static generatedTimeSeriesDateFromAtLevel(
    anchor: string,
    levelExpr = StarRocksQuery.levelExpr(),
  ): string {
    return '{% set g = granularity | replace("\'", "") | trim | lower %}'
      + `{% if g == '1 second' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) SECOND)`
      + `{% elif g == '1 minute' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) MINUTE)`
      + `{% elif g == '1 hour' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) HOUR)`
      + `{% elif g == '1 day' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) DAY)`
      + `{% elif g == '1 week' %}DATE_ADD(${anchor}, INTERVAL ((${levelExpr} - 1) * 7) DAY)`
      + `{% elif g == '1 month' %}months_add(${anchor}, ${levelExpr} - 1)`
      + `{% elif g == '3 month' %}months_add(${anchor}, (${levelExpr} - 1) * 3)`
      + `{% elif g == '1 quarter' %}months_add(${anchor}, (${levelExpr} - 1) * 3)`
      + `{% elif g == '1 year' %}months_add(${anchor}, (${levelExpr} - 1) * 12)`
      + `{% else %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) DAY){% endif %}`;
  }

  private static generatedTimeSeriesDateToAtLevel(
    anchor: string,
    levelExpr = StarRocksQuery.levelExpr(),
  ): string {
    return '{% set g = granularity | replace("\'", "") | trim | lower %}'
      + `{% if g == '1 second' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} SECOND), INTERVAL 1 SECOND)`
      + `{% elif g == '1 minute' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} MINUTE), INTERVAL 1 SECOND)`
      + `{% elif g == '1 hour' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} HOUR), INTERVAL 1 SECOND)`
      + `{% elif g == '1 day' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} DAY), INTERVAL 1 SECOND)`
      + `{% elif g == '1 week' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL (${levelExpr} * 7) DAY), INTERVAL 1 SECOND)`
      + `{% elif g == '1 month' %}DATE_SUB(months_add(${anchor}, ${levelExpr}), INTERVAL 1 SECOND)`
      + `{% elif g == '3 month' %}DATE_SUB(months_add(${anchor}, ${levelExpr} * 3), INTERVAL 1 SECOND)`
      + `{% elif g == '1 quarter' %}DATE_SUB(months_add(${anchor}, ${levelExpr} * 3), INTERVAL 1 SECOND)`
      + `{% elif g == '1 year' %}DATE_SUB(months_add(${anchor}, ${levelExpr} * 12), INTERVAL 1 SECOND)`
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

  private static generatedTimeSeriesSeriesJoinFromBounds(levelLimitSql: string): string {
    return `, generate_series(CAST(1 AS BIGINT), CAST((${levelLimitSql}) AS BIGINT)) AS gen`;
  }

  private static generatedTimeSeriesSelectTemplate(): string {
    const anchor = StarRocksQuery.generatedTimeSeriesDateAnchor('{{ start }}');
    const levelLimit = StarRocksQuery.generatedTimeSeriesLevelLimit('{{ start }}', '{{ end }}');
    return 'SELECT\n'
      + `  ${StarRocksQuery.generatedTimeSeriesDateFromAtLevel(anchor)} AS date_from,\n`
      + `  ${StarRocksQuery.generatedTimeSeriesDateToAtLevel(anchor)} AS date_to\n`
      + `FROM TABLE(generate_series(1, ${levelLimit})) AS gen`;
  }

  private static generatedTimeSeriesWithCteRangeSourceTemplate(): string {
    const anchor = StarRocksQuery.generatedTimeSeriesDateAnchor('bounds.{{ min_name }}');
    const levelLimit = StarRocksQuery.generatedTimeSeriesLevelLimit(
      'bounds.{{ min_name }}',
      'bounds.{{ max_name }}',
    );
    return 'SELECT\n'
      + `  ${StarRocksQuery.generatedTimeSeriesDateFromAtLevel(anchor)} AS date_from,\n`
      + `  ${StarRocksQuery.generatedTimeSeriesDateToAtLevel(anchor)} AS date_to\n`
      + 'FROM (\n'
      + '  SELECT {{ range_source }}.{{ min_name }} AS {{ min_name }}, {{ range_source }}.{{ max_name }} AS {{ max_name }}\n'
      + '  FROM {{ range_source }}\n'
      + ') bounds\n'
      + `${StarRocksQuery.generatedTimeSeriesSeriesJoinFromBounds(levelLimit)}`;
  }

  public sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.statements.generated_time_series_select =
      StarRocksQuery.generatedTimeSeriesSelectTemplate();
    templates.statements.generated_time_series_with_cte_range_source =
      StarRocksQuery.generatedTimeSeriesWithCteRangeSourceTemplate();
    return templates;
  }
}
