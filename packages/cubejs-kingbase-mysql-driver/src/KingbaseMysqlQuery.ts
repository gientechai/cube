import moment from 'moment-timezone';
import { MysqlQuery } from '@cubejs-backend/schema-compiler';

const DATE_SERIES_INCREMENT = 'DATE_ADD(date_from, INTERVAL \'{{ granularity }}\')';
const DATE_SERIES_END = 'DATE_SUB(CAST({{ end }} AS DATETIME), INTERVAL \'1000 MICROSECOND\')';
const quoteSimpleInterval = (sql: string) => sql.replace(/INTERVAL (\d+(?:\.\d+)? [A-Z_]+)/g, 'INTERVAL \'$1\'');

const GRANULARITY_TO_INTERVAL: Record<string, (date: string) => string> = {
  day: (date: string) => `DATE_FORMAT(${date}, '%Y-%m-%d 00:00:00.000')`,
  week: (date: string) => `DATE_FORMAT(DATE_ADD('1900-01-01', INTERVAL TIMESTAMPDIFF(WEEK, '1900-01-01', ${date}) WEEK), '%Y-%m-%d 00:00:00.000')`,
  hour: (date: string) => `DATE_FORMAT(${date}, '%Y-%m-%d %H:00:00.000')`,
  minute: (date: string) => `DATE_FORMAT(${date}, '%Y-%m-%d %H:%i:00.000')`,
  second: (date: string) => `DATE_FORMAT(${date}, '%Y-%m-%d %H:%i:%S.000')`,
  month: (date: string) => `DATE_FORMAT(${date}, '%Y-%m-01 00:00:00.000')`,
  quarter: (date: string) => `DATE_ADD('1900-01-01', INTERVAL TIMESTAMPDIFF(QUARTER, '1900-01-01', ${date}) QUARTER)`,
  year: (date: string) => `DATE_FORMAT(${date}, '%Y-01-01 00:00:00.000')`,
};

export class KingbaseMysqlQuery extends MysqlQuery {
  public convertTz(field: string) {
    return `CONVERT_TZ(${field}, '+00:00', '${moment().tz(this.timezone).format('Z')}')`;
  }

  public timeStampCast(value: string) {
    return `CAST(CONVERT_TZ(CAST(${value} AS DATETIME(3)), '+00:00', '${moment().tz(this.timezone).format('Z')}') AS DATETIME(3))`;
  }

  public timeGroupedColumn(granularity: string, dimension: string) {
    return `CAST(${GRANULARITY_TO_INTERVAL[granularity](dimension)} AS DATETIME)`;
  }

  public subtractInterval(date: string, interval: string) {
    return quoteSimpleInterval(super.subtractInterval(date, interval));
  }

  public addInterval(date: string, interval: string) {
    return quoteSimpleInterval(super.addInterval(date, interval));
  }

  public sqlTemplates() {
    const templates = super.sqlTemplates();

    templates.statements.generated_time_series_select =
      'WITH RECURSIVE date_series (date_from) AS (\n' +
      '  SELECT CAST({{ start }} AS DATETIME) AS date_from\n' +
      '  UNION ALL\n' +
      `  SELECT CAST(${DATE_SERIES_INCREMENT} AS DATETIME)\n` +
      '  FROM date_series\n' +
      `  WHERE ${DATE_SERIES_INCREMENT} <= ${DATE_SERIES_END}\n` +
      ')\n' +
      'SELECT CAST(date_from AS DATETIME) AS date_from,\n' +
      `       DATE_SUB(${DATE_SERIES_INCREMENT}, INTERVAL '1000 MICROSECOND') AS date_to\n` +
      'FROM date_series';

    templates.statements.generated_time_series_with_cte_range_source =
      'WITH RECURSIVE date_series (date_from, max_date) AS (\n' +
      '  SELECT CAST({{ range_source }}.{{ min_name }} AS DATETIME) AS date_from,\n' +
      '         CAST({{ range_source }}.{{ max_name }} AS DATETIME) AS max_date\n' +
      '  FROM {{ range_source }}\n' +
      '  UNION ALL\n' +
      `  SELECT CAST(${DATE_SERIES_INCREMENT} AS DATETIME), max_date\n` +
      '  FROM date_series\n' +
      `  WHERE ${DATE_SERIES_INCREMENT} <= max_date\n` +
      ')\n' +
      'SELECT CAST(date_from AS DATETIME) AS date_from,\n' +
      `       DATE_SUB(${DATE_SERIES_INCREMENT}, INTERVAL '1000 MICROSECOND') AS date_to\n` +
      'FROM date_series';

    return templates;
  }
}
