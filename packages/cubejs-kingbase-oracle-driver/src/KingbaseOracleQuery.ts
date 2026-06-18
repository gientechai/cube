import { OracleQuery } from '@cubejs-backend/schema-compiler';

const DATE_SERIES_INCREMENT =
  '{% if minimal_time_unit|upper == \'YEAR\' %}' +
  'ADD_MONTHS(date_from, 12)' +
  '{% elif minimal_time_unit|upper == \'QUARTER\' %}' +
  'ADD_MONTHS(date_from, 3)' +
  '{% elif minimal_time_unit|upper == \'MONTH\' %}' +
  'ADD_MONTHS(date_from, 1)' +
  '{% elif minimal_time_unit|upper == \'WEEK\' %}' +
  'date_from + NUMTODSINTERVAL(7, \'DAY\')' +
  '{% else %}' +
  'date_from + NUMTODSINTERVAL(1, \'{{ minimal_time_unit|upper }}\')' +
  '{% endif %}';

export class KingbaseOracleQuery extends OracleQuery {
  public timeGroupedColumn(granularity: string, dimension: string) {
    if (granularity === 'quarter') {
      return `TRUNC(${dimension}, 'Q')`;
    }

    return super.timeGroupedColumn(granularity, dimension);
  }

  public supportGeneratedSeriesForCustomTd() {
    return true;
  }

  public sqlTemplates() {
    const templates = super.sqlTemplates();

    templates.statements.generated_time_series_select =
      'WITH date_series (date_from) AS (\n' +
      '  SELECT CAST({{ start }} AS TIMESTAMP) AS date_from\n' +
      '  UNION ALL\n' +
      `  SELECT ${DATE_SERIES_INCREMENT}\n` +
      '  FROM date_series\n' +
      `  WHERE ${DATE_SERIES_INCREMENT} <= CAST({{ end }} AS TIMESTAMP)\n` +
      ')\n' +
      'SELECT date_from,\n' +
      `       ${DATE_SERIES_INCREMENT} - NUMTODSINTERVAL(0.001, 'SECOND') AS date_to\n` +
      'FROM date_series';

    templates.statements.generated_time_series_with_cte_range_source =
      'WITH date_series (date_from, max_date) AS (\n' +
      '  SELECT {{ range_source }}.{{ min_name }} AS date_from,\n' +
      '         {{ range_source }}.{{ max_name }} AS max_date\n' +
      '  FROM {{ range_source }}\n' +
      '  UNION ALL\n' +
      `  SELECT ${DATE_SERIES_INCREMENT}, max_date\n` +
      '  FROM date_series\n' +
      `  WHERE ${DATE_SERIES_INCREMENT} <= max_date\n` +
      ')\n' +
      'SELECT date_from,\n' +
      `       ${DATE_SERIES_INCREMENT} - NUMTODSINTERVAL(0.001, 'SECOND') AS date_to\n` +
      'FROM date_series';

    return templates;
  }
}
