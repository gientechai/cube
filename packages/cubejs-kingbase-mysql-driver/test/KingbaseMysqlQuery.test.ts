import { MysqlQuery } from '@cubejs-backend/schema-compiler';
import { KingbaseMysqlQuery } from '../src';

describe('Kingbase MySQL SQL Dialect', () => {
  test('starts from MySQL SQL semantics', () => {
    expect(KingbaseMysqlQuery.prototype).toBeInstanceOf(MysqlQuery);
  });

  test('uses Kingbase-compatible generated time series templates', () => {
    const query = Object.create(KingbaseMysqlQuery.prototype) as KingbaseMysqlQuery;
    const templates = query.sqlTemplates();

    expect(templates.statements.generated_time_series_select).toContain('WITH RECURSIVE date_series (date_from) AS');
    expect(templates.statements.generated_time_series_select).toContain('SELECT CAST({{ start }} AS DATETIME) AS date_from');
    expect(templates.statements.generated_time_series_select).toContain("DATE_ADD(date_from, INTERVAL '{{ granularity }}')");
    expect(templates.statements.generated_time_series_select).toContain("DATE_SUB(DATE_ADD(date_from, INTERVAL '{{ granularity }}'), INTERVAL '1000 MICROSECOND') AS date_to");
    expect(templates.statements.generated_time_series_select).toContain("DATE_ADD(date_from, INTERVAL '{{ granularity }}') <= DATE_SUB(CAST({{ end }} AS DATETIME), INTERVAL '1000 MICROSECOND')");
    expect(templates.statements.generated_time_series_select).not.toContain('INTERVAL 1000 MICROSECOND');
    expect(templates.statements.generated_time_series_select).not.toContain("CAST(DATE_SUB(DATE_ADD(date_from, INTERVAL '{{ granularity }}'), INTERVAL '1000 MICROSECOND') AS DATETIME)");
    expect(templates.statements.generated_time_series_select).not.toContain('TIMESTAMP({{ start }})');
    expect(templates.statements.generated_time_series_with_cte_range_source).toContain('WITH RECURSIVE date_series (date_from, max_date) AS');
    expect(templates.statements.generated_time_series_with_cte_range_source).toContain('CAST({{ range_source }}.{{ min_name }} AS DATETIME)');
  });

  test('does not depend on MySQL session timezone variables', () => {
    const query = Object.create(KingbaseMysqlQuery.prototype) as KingbaseMysqlQuery;
    (query as any).timezone = 'UTC';

    expect(query.convertTz('orders.created_at')).toEqual(
      "CONVERT_TZ(orders.created_at, '+00:00', '+00:00')"
    );
    expect(query.timeStampCast('?')).toEqual(
      "CAST(CONVERT_TZ(CAST(? AS DATETIME(3)), '+00:00', '+00:00') AS DATETIME(3))"
    );
    expect(query.convertTz('orders.created_at')).not.toContain('@@session.time_zone');
    expect(query.timeStampCast('?')).not.toContain('@@session.time_zone');
  });

  test('uses Kingbase-compatible time grouping formats', () => {
    const query = Object.create(KingbaseMysqlQuery.prototype) as KingbaseMysqlQuery;

    expect(query.timeGroupedColumn('month', 'orders.created_at')).toEqual(
      "CAST(DATE_FORMAT(orders.created_at, '%Y-%m-01 00:00:00.000') AS DATETIME)"
    );
    expect(query.timeGroupedColumn('day', 'orders.created_at')).toEqual(
      "CAST(DATE_FORMAT(orders.created_at, '%Y-%m-%d 00:00:00.000') AS DATETIME)"
    );
    expect(query.timeGroupedColumn('hour', 'orders.created_at')).toEqual(
      "CAST(DATE_FORMAT(orders.created_at, '%Y-%m-%d %H:00:00.000') AS DATETIME)"
    );
    expect(query.timeGroupedColumn('month', 'orders.created_at')).not.toContain('T00:00:00.000');
  });

  test('quotes simple interval values for Kingbase DATE_ADD and DATE_SUB parsing', () => {
    const query = Object.create(KingbaseMysqlQuery.prototype) as KingbaseMysqlQuery;

    expect(query.addInterval('orders.created_at', '1 year')).toEqual(
      "DATE_ADD(orders.created_at, INTERVAL '1 YEAR')"
    );
    expect(query.subtractInterval('orders.created_at', '2 days')).toEqual(
      "DATE_SUB(orders.created_at, INTERVAL '2 DAY')"
    );
    expect(query.addInterval('orders.created_at', '1 year')).not.toContain('INTERVAL 1 YEAR');
  });
});
