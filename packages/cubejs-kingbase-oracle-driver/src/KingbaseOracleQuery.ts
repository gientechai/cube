import { parseSqlInterval } from '@cubejs-backend/shared';
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

  public addInterval(date: string, interval: string): string {
    return this.shiftInterval(date, interval, 1);
  }

  public subtractInterval(date: string, interval: string): string {
    return this.shiftInterval(date, interval, -1);
  }

  private shiftInterval(date: string, interval: string, direction: 1 | -1): string {
    const intervalParsed = parseSqlInterval(interval);
    let res = date;

    const totalMonths =
      (intervalParsed.year || 0) * 12 +
      (intervalParsed.quarter || 0) * 3 +
      (intervalParsed.month || 0);

    if (totalMonths !== 0) {
      res = `ADD_MONTHS(${res}, ${totalMonths * direction})`;
    }

    const totalDays = (intervalParsed.week || 0) * 7 + (intervalParsed.day || 0);
    if (totalDays !== 0) {
      res = this.applyDaySecondInterval(res, totalDays, 'DAY', direction);
    }
    if (intervalParsed.hour) {
      res = this.applyDaySecondInterval(res, intervalParsed.hour, 'HOUR', direction);
    }
    if (intervalParsed.minute) {
      res = this.applyDaySecondInterval(res, intervalParsed.minute, 'MINUTE', direction);
    }
    if (intervalParsed.second) {
      res = this.applyDaySecondInterval(res, intervalParsed.second, 'SECOND', direction);
    }

    return res;
  }

  private applyDaySecondInterval(date: string, value: number, unit: string, direction: 1 | -1): string {
    const operator = direction === 1 ? '+' : '-';
    return `${date} ${operator} NUMTODSINTERVAL(${value}, '${unit}')`;
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
