import { GaussDBQuery } from '../../src/adapter/GaussDBQuery';
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { queryClass } from '../../src/adapter/QueryBuilder';
import { prepareJsCompiler } from './PrepareCompiler';

describe('GaussDBQuery (independent PG-mode JDBC dialect)', () => {
  const compilers = prepareJsCompiler(`
    cube('Orders', {
      sql: 'SELECT * FROM orders',
      measures: { count: { type: 'count' } },
      dimensions: {
        id: { sql: 'id', type: 'number', primaryKey: true },
        name: { sql: 'name', type: 'string' },
        createdAt: { sql: 'created_at', type: 'time' }
      }
    });
  `, {
    // JS schema compilation only; no Jinja/Python/native planner in this unit test.
    nativeInstance: { newJinjaEngine: () => ({}) },
  });

  it('registers an independent dialect and binds repeated parameters in SQL order', async () => {
    await compilers.compiler.compile();
    const query = new GaussDBQuery(compilers, {
      measures: ['Orders.count'],
      filters: [{ member: 'Orders.name', operator: 'equals', values: ['O\'Brien ? $1 中文'] }],
      timezone: 'UTC',
    });
    expect(queryClass('gaussdb', undefined)).toBe(GaussDBQuery);
    expect(query).not.toBeInstanceOf(PostgresQuery);
    const [sql, params] = query.buildSqlAndParams();
    expect(sql).toContain(' = ?');
    expect(sql).not.toMatch(/\$\d+/);
    expect(params).toEqual(['O\'Brien ? $1 中文']);

    const allocator = query.newParamAllocator([]);
    const first = allocator.allocateParam('first');
    const second = allocator.allocateParam('second');
    expect(allocator.buildSqlAndParams(`SELECT ${second}, ${first}, ${second}`, false, query.shouldReuseParams))
      .toEqual(['SELECT ?, ?, ?', ['second', 'first', 'second']]);
    expect(query.sqlTemplates().params.param).toBe('?');
  });

  it('retains PG time SQL and project-specific period_average expressions', () => {
    const query = Object.create(GaussDBQuery.prototype);
    expect(query.timeGroupedColumn('quarter', 'created_at')).toBe('date_trunc(\'quarter\', created_at)');
    expect(query.intervalString('1 quarter')).toBe('\'3 months\'');
    expect(query.periodAverageDaysInMonthBucket('bucket')).toContain('INTERVAL \'1 month\'');
    expect(query.sqlTemplates().statements.generated_time_series_select).toContain('generate_series');
  });
});
