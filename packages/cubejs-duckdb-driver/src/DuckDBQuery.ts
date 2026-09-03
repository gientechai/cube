import { BaseFilter, BaseQuery } from '@cubejs-backend/schema-compiler';

const duckDbDateTruncUtc = (unit: string, date: string) =>
  `date_trunc('${unit}', ${date})`;

const GRANULARITY_TO_INTERVAL: Record<string, (date: string) => string> = {
  day: date => duckDbDateTruncUtc('day', date),
  week: date => duckDbDateTruncUtc('week', date),
  hour: date => duckDbDateTruncUtc('hour', date),
  minute: date => duckDbDateTruncUtc('minute', date),
  second: date => duckDbDateTruncUtc('second', date),
  month: date => duckDbDateTruncUtc('month', date),
  quarter: date => duckDbDateTruncUtc('quarter', date),
  year: date => duckDbDateTruncUtc('year', date)
};

class DuckDBFilter extends BaseFilter {
  public castParameter() {
    const numberTypes = ['number', 'count', 'count_distinct', 'count_distinct_approx', 'sum', 'avg', 'min', 'max'];
    const definition = this.definition();

    if (numberTypes.includes(definition.type)) {
      return 'CAST(? AS DOUBLE)';
    }
   
    return '?';
  }
}

export class DuckDBQuery extends BaseQuery {
  public newFilter(filter: any): BaseFilter {
    return new DuckDBFilter(this, filter);
  }

  public convertTz(field: string) {
    return `timezone('${this.timezone}', ${field}::timestamptz)`;
  }

  public timeGroupedColumn(granularity: string, dimension: string) {
    const truncated = GRANULARITY_TO_INTERVAL[granularity](dimension);
    // DuckDB date_trunc() on timestamptz yields DATE; Tesseract multi-stage time_series emits
    // TIMESTAMPTZ at UTC midnight. Cast truncated buckets back to timestamptz so UNION/JOIN keys align.
    return `timezone('${this.timezone}', ${truncated}::timestamp)`;
  }

  /**
   * Returns sql for source expression floored to timestamps aligned with
   * intervals relative to origin timestamp point.
   * DuckDB operates with whole intervals as is without measuring them in plain seconds,
   * so the resulting date will be human-expected aligned with intervals.
   */
  public dateBin(interval: string, source: string, origin: string): string {
    const timeUnit = this.diffTimeUnitForInterval(interval);
    const beginOfTime = this.dateTimeCast('\'1970-01-01 00:00:00.000\'');

    return `${this.dateTimeCast(`'${origin}'`)}' + INTERVAL '${interval}' *
      floor(
        date_diff('${timeUnit}', ${this.dateTimeCast(`'${origin}'`)}, ${source}) /
        date_diff('${timeUnit}', ${beginOfTime}, ${beginOfTime} + INTERVAL '${interval}')
      )::int`;
  }

  public countDistinctApprox(sql: string) {
    return `approx_count_distinct(${sql})`;
  }

  public sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.functions.DATETRUNC = 'date_trunc({{ args_concat }})';
    templates.functions.LEAST = 'LEAST({{ args_concat }})';
    templates.functions.GREATEST = 'GREATEST({{ args_concat }})';
    templates.functions.STRING_AGG = 'STRING_AGG({% if distinct %}DISTINCT {% endif %}{{ args[0] }}, COALESCE({{ args[1] }}, \'\'))';
    templates.expressions.like = '{{ expr }} {% if negated %}NOT {% endif %}LIKE {{ pattern }}{% if default_escape %} ESCAPE \'\\\'{% endif %}';
    templates.expressions.ilike = '{{ expr }} {% if negated %}NOT {% endif %}ILIKE {{ pattern }}{% if default_escape %} ESCAPE \'\\\'{% endif %}';
    // Tesseract rollingWindow / time_shift：DuckDB 的 generate_series 在 FROM 中返回 STRUCT，需 unnest；
    // 边界用 timezone('UTC', ...) 避免本地时区导致日桶偏移（MTD/YTD 累计错位）。
    templates.statements.generated_time_series_select = 'SELECT {{ date_from }} AS "date_from",\n'
      + '{{ date_to }} AS "date_to" \n'
      + 'FROM (SELECT unnest(generate_series(timezone(\'UTC\', {{ start }}::timestamp), timezone(\'UTC\', {{ end }}::timestamp), {{ granularity }}::interval)) AS d)';
    templates.statements.generated_time_series_with_cte_range_source = 'SELECT timezone(\'UTC\', d) AS "date_from",\n'
      + 'timezone(\'UTC\', d) + interval {{ granularity }} - interval \'1 millisecond\' AS "date_to" \n'
      + 'FROM {{ range_source }}, (SELECT unnest(generate_series(timezone(\'UTC\', {{ range_source }}.{{ min_name }}), timezone(\'UTC\', {{ range_source }}.{{ max_name }}), {{ granularity }}::interval)) AS d)';
    // DuckDB：date_trunc 日桶与 timestamptz 直接 <= 比较会跨日误判；rollingWindow to_date 用 epoch 对齐边界。
    templates.expressions.to_date_rolling_window_join = 'epoch({{ date_column }}) >= epoch({{ grouped_from }}) and epoch({{ date_column }}) <= epoch({{ date_to }})';
    templates.filters.time_range_filter = 'epoch({{ column }}) >= epoch({{ from_timestamp }}) AND epoch({{ column }}) <= epoch({{ to_timestamp }})';
    return templates;
  }

  public timeStampParam(timeDimension: any) {
    if (timeDimension.measure) {
      // For time measures, we don't need to check dateFieldType
      return super.timeStampCast('?');
    }
    return super.timeStampParam(timeDimension);
  }
}
