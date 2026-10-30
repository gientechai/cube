import R from 'ramda';

import { BaseQuery } from './BaseQuery';
import { BaseFilter } from './BaseFilter';

const GRANULARITY_TO_INTERVAL = {
  day: (date) => `DATE_FORMAT(${date}, 'yyyy-MM-dd 00:00:00.000')`,
  week: (date) => `DATE_FORMAT(from_unixtime(unix_timestamp('1900-01-01 00:00:00') + floor((unix_timestamp(${date}) - unix_timestamp('1900-01-01 00:00:00')) / (60 * 60 * 24 * 7)) * (60 * 60 * 24 * 7)), 'yyyy-MM-dd 00:00:00.000')`,
  hour: (date) => `DATE_FORMAT(${date}, 'yyyy-MM-dd HH:00:00.000')`,
  minute: (date) => `DATE_FORMAT(${date}, 'yyyy-MM-dd HH:mm:00.000')`,
  second: (date) => `DATE_FORMAT(${date}, 'yyyy-MM-dd HH:mm:ss.000')`,
  month: (date) => `DATE_FORMAT(${date}, 'yyyy-MM-01 00:00:00.000')`,
  year: (date) => `DATE_FORMAT(${date}, 'yyyy-01-01 00:00:00.000')`
};

class HiveFilter extends BaseFilter {
  public likeIgnoreCase(column, not, param, type) {
    const p = (!type || type === 'contains' || type === 'ends') ? '%' : '';
    const s = (!type || type === 'contains' || type === 'starts') ? '%' : '';
    return `${column}${not ? ' NOT' : ''} LIKE CONCAT('${p}', ${this.allocateParam(param)}, '${s}')`;
  }
}

export class HiveQuery extends BaseQuery {
  public newFilter(filter) {
    return new HiveFilter(this as BaseQuery, filter);
  }

  public convertTz(field) {
    return `from_utc_timestamp(${field}, '${this.timezone}')`;
  }

  public timeStampCast(value) {
    return `from_utc_timestamp(replace(replace(${value}, 'T', ' '), 'Z', ''), 'UTC')`;
  }

  public dateTimeCast(value) {
    return `from_utc_timestamp(${value}, 'UTC')`; // TODO
  }

  public subtractInterval(date, interval) {
    const [number, type] = this.parseInterval(interval);

    return `(${date} - INTERVAL '${number}' ${type})`;
  }

  public addInterval(date, interval) {
    const [number, type] = this.parseInterval(interval);

    return `(${date} + INTERVAL '${number}' ${type})`;
  }

  public timeGroupedColumn(granularity, dimension) {
    return GRANULARITY_TO_INTERVAL[granularity](dimension);
  }

  public escapeColumnName(name) {
    return `\`${name}\``;
  }

  /**
   * Tesseract uses this template object directly, so Hive identifiers must be
   * quoted with backticks here as well. Without this override the default
   * Postgres templates emit "test".column, which Hive parses as a string literal.
   */
  public sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.quotes.identifiers = '`';
    templates.quotes.escape = '\\`';
    // Hive doesn't accept Postgres-style positional GROUP BY.
    // ORDER BY keeps BaseQuery's index form (ORDER BY 1), which Hive supports.
    templates.statements.group_by_exprs = "{{ group_by | map(attribute='expr') | join(', ') }}";
    // BaseQuery uses Postgres `date_from::timestamp` and a VALUES row constructor.
    // Hive needs CAST(... AS TIMESTAMP) and a UNION ALL derived table instead.
    templates.statements.time_series_select =
      'SELECT CAST(replace(replace(dates.f, \'T\', \' \'), \'Z\', \'\') AS TIMESTAMP) AS date_from, CAST(replace(replace(dates.t, \'T\', \' \'), \'Z\', \'\') AS TIMESTAMP) AS date_to\n' +
      'FROM (\n' +
      '{% for time_item in seria %}' +
      "  SELECT '{{ time_item[0] }}' f, '{{ time_item[1] }}' t\n" +
      '{% if not loop.last %}  UNION ALL\n{% endif %}' +
      '{% endfor %}' +
      ') AS dates';
    return templates;
  }


  /**
   * Tesseract builds rolling-window bounds as two scalar subqueries:
   *   (SELECT min(`date_from`) `value` FROM time_series)
   *   (SELECT max(`date_to`) `value` FROM time_series)
   * Hive 3 rejects more than one subquery expression in WHERE. For a Hive
   * query with an explicit time series we can inline the two known bounds.
   */
  public buildSqlAndParams(exportAnnotatedSql?: boolean): [string, any[]] {
    const [sql, params] = super.buildSqlAndParams(exportAnnotatedSql);
    return [this.inlineTimeSeriesBounds(sql), params];
  }

  private inlineTimeSeriesBounds(sql: string): string {
    const minSubquery = /\(SELECT min\(`date_from`\) `value`\s+FROM time_series\)/g;
    const maxSubquery = /\(SELECT max\(`date_to`\) `value`\s+FROM time_series\)/g;
    if (!minSubquery.test(sql) || !maxSubquery.test(sql)) {
      return sql;
    }
    // Reset lastIndex after test(), since both regexes are global.
    minSubquery.lastIndex = 0;
    maxSubquery.lastIndex = 0;

    const series = [...sql.matchAll(/'([^']+)' f, '([^']+)' t/g)];
    if (series.length === 0) {
      return sql;
    }
    const castLiteral = (value: string) =>
      `CAST(replace(replace('${value}', 'T', ' '), 'Z', '') AS TIMESTAMP)`;
    return sql
      .replace(minSubquery, castLiteral(series[0][1]))
      .replace(maxSubquery, castLiteral(series[series.length - 1][2]));
  }

  public simpleQuery() {
    const ungrouped = this.evaluateSymbolSqlWithContext(
      () => `${this.commonQuery()} ${this.baseWhere(this.allFilters)}`, {
        ungroupedForWrappingGroupBy: true
      }
    );
    const select = this.evaluateSymbolSqlWithContext(
      () => this.dimensionsForSelect().map(
        d => d.aliasName()
      ).concat(this.measures.flatMap(m => m.selectColumns())).filter(s => !!s), {
        ungroupedAliases: R.fromPairs(this.forSelect().map((m: any) => [m.measure || m.dimension, m.aliasName()]))
      }
    );
    const query = `SELECT ${select} FROM (${ungrouped}) AS ${this.escapeColumnName('hive_wrapper')}
    ${this.groupByClause()}`;
    return this.baseHaving(query, this.measureFilters) + this.orderBy() + this.groupByDimensionLimit();
  }

  public seriesSql(timeDimension) {
    const values = timeDimension.timeSeries().map(
      ([from, to]) => `select '${from}' f, '${to}' t`
    ).join(' UNION ALL ');
    return `SELECT ${this.timeStampCast('dates.f')} date_from, ${this.timeStampCast('dates.t')} date_to FROM (${values}) AS dates`;
  }

  public groupByClause() {
    const dimensionsForSelect = this.dimensionsForSelect();
    const dimensionColumns =
      R.flatten(dimensionsForSelect.map(
        s => s.selectColumns() && s.aliasName()
      )).filter(s => !!s);
    return dimensionColumns.length ? ` GROUP BY ${dimensionColumns.join(', ')}` : '';
  }

  public getFieldIndex(id) {
    const idx = super.getFieldIndex(id);

    if (idx !== null) {
      return idx;
    }

    return this.escapeColumnName(this.aliasName(id));
  }

  public unixTimestampSql() {
    return 'unix_timestamp()';
  }

  public defaultRefreshKeyRenewalThreshold() {
    return 120;
  }
}
