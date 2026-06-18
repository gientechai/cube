import { KingbaseOracleQuery } from '../src';

describe('Kingbase Oracle Query dialect', () => {
  test('supports quarter time dimension grouping', () => {
    const query = Object.create(KingbaseOracleQuery.prototype) as KingbaseOracleQuery;

    expect(query.timeGroupedColumn('quarter', 'created_at')).toEqual("TRUNC(created_at, 'Q')");
  });

  test('supports week interval arithmetic', () => {
    const query = Object.create(KingbaseOracleQuery.prototype) as KingbaseOracleQuery;

    expect(query.addInterval('created_at', '1 week')).toEqual(
      "created_at + NUMTODSINTERVAL(7, 'DAY')"
    );
    expect(query.subtractInterval('created_at', '1 week')).toEqual(
      "created_at - NUMTODSINTERVAL(7, 'DAY')"
    );
    expect(query.addInterval('created_at', '1 week 2 days')).toEqual(
      "created_at + NUMTODSINTERVAL(9, 'DAY')"
    );
    expect(query.addInterval('created_at', '1 quarter')).toEqual(
      'ADD_MONTHS(created_at, 3)'
    );
  });

  test('supports generated time series using recursive CTE templates', () => {
    const query = Object.create(KingbaseOracleQuery.prototype) as KingbaseOracleQuery;
    const templates = query.sqlTemplates();

    expect(query.supportGeneratedSeriesForCustomTd()).toEqual(true);
    expect(templates.statements.generated_time_series_select).toContain('WITH date_series (date_from) AS');
    expect(templates.statements.generated_time_series_select).toContain("NUMTODSINTERVAL(1, '{{ minimal_time_unit|upper }}')");
    expect(templates.statements.generated_time_series_select).toContain('ADD_MONTHS(date_from, 3)');
    expect(templates.statements.generated_time_series_select).toContain("NUMTODSINTERVAL(7, 'DAY')");
    expect(templates.statements.generated_time_series_select).toContain("NUMTODSINTERVAL(0.001, 'SECOND')");
    expect(templates.statements.generated_time_series_with_cte_range_source).toContain('WITH date_series (date_from, max_date) AS');
    expect(templates.statements.generated_time_series_with_cte_range_source).toContain('FROM {{ range_source }}');
  });
});
