import { NativeInstance } from '@cubejs-backend/native';
import { MssqlQuery } from '../../src/adapter/MssqlQuery';
import { MysqlQuery } from '../../src/adapter/MysqlQuery';
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { prepareJsCompiler } from './PrepareCompiler';

const schema = `cube('Sales', {
  sql: 'SELECT * FROM (VALUES (1, 10), (2, 20), (3, NULL)) AS sales(id, amount)',
  measures: { amount: { sql: 'amount', type: 'sum' }, count: { type: 'count' } },
  dimensions: { id: { sql: 'id', type: 'number', primaryKey: true }, amountValue: { sql: 'amount', type: 'number' } }
});`;

describe('SQL Server 2016 SQL compatibility', () => {
  const compilers = prepareJsCompiler(schema, { adapter: 'mssql' });
  const jinja = new NativeInstance().newJinjaEngine({ debugInfo: true, filters: {}, workers: 1 });

  beforeAll(async () => {
    await compilers.compiler.compile();
    const templates = new MssqlQuery(compilers, {}).sqlTemplates();
    for (const name of ['LEAST', 'GREATEST']) {
      // Schema Jinja defaults to JSON escaping; SQL template renderers do not.
      jinja.loadTemplate(name, `{% autoescape false %}${templates.functions[name]}{% endautoescape %}`);
    }
    jinja.loadTemplate('sort', `{% autoescape false %}${templates.expressions.sort}{% endautoescape %}`);
  });

  it('preserves SQL API aliases when Tesseract is enabled', () => {
    const options = {
      measures: ['Sales.amount'],
      memberToAlias: { 'Sales.amount': 'sum_sales_amount' },
      useNativeSqlPlanner: true,
    };
    const [sql] = new MssqlQuery(compilers, options).buildSqlAndParams();
    expect(sql).toContain('"sum_sales_amount"');
    expect(sql).not.toContain('"sales__amount"');
    expect(options.useNativeSqlPlanner).toBe(true);
  });

  it('keeps ordinary MSSQL queries on the configured native planner', () => {
    const query = new MssqlQuery(compilers, {
      measures: ['Sales.amount'],
      memberToAlias: {},
      useNativeSqlPlanner: true,
    });
    const [sql] = query.buildSqlAndParams();
    expect(query.useNativeSqlPlanner).toBe(true);
    expect(sql).toContain('"sales__amount"');
  });

  it('renders expression measures without treating their objects as member paths', () => {
    const query = new MssqlQuery(compilers, {
      measures: [{
        cubeName: 'Sales',
        name: 'expression_total',
        expression: (Sales) => `SUM(${Sales.amountValue})`,
        definition: JSON.stringify({
          cubeName: 'Sales',
          alias: 'expression_total',
          // eslint-disable-next-line no-template-curly-in-string
          expr: { type: 'SqlFunction', cubeParams: ['Sales'], sql: 'SUM(${Sales.amountValue})' },
        }),
      }],
      useNativeSqlPlanner: true,
    });
    const [sql] = query.buildSqlAndParams();
    expect(sql).toMatch(/SUM\(.*amount/i);
    expect(sql).toContain('"sales__expression_total"');
  });

  it.each([false, true])('builds legal grouped and paginated ordering (Tesseract=%s)', (useNativeSqlPlanner) => {
    const query = new MssqlQuery(compilers, {
      measures: ['Sales.amount'],
      dimensions: ['Sales.id'],
      order: [{ id: 'Sales.amount', desc: false }, { id: 'Sales.id', desc: true }],
      rowLimit: 2,
      offset: 1,
      useNativeSqlPlanner,
    });
    const [sql] = query.buildSqlAndParams();
    expect(sql).toMatch(/ORDER BY/i);
    expect(sql).not.toMatch(/IS NULL\s+(ASC|DESC)/i);
    expect(sql).toMatch(/OFFSET\s+1\s+ROWS/i);
    expect(sql).toMatch(/FETCH NEXT\s+2\s+ROWS ONLY/i);
  });

  it.each([[true, true], [false, false], [true, false], [false, true]])(
    'renders explicit NULL order as a legal SQL expression (asc=%s, nullsFirst=%s)',
    async (asc, nullsFirst) => {
      const sql = await jinja.renderTemplate('sort', {}, { expr: 'src.amount', asc, nulls_first: nullsFirst });
      expect(sql).not.toMatch(/IS NULL\s+(ASC|DESC)/i);
      if (asc === nullsFirst) {
        expect(sql.trim()).toBe(`src.amount ${asc ? 'ASC' : 'DESC'}`);
      } else {
        expect(sql).toMatch(/CASE WHEN src.amount IS NULL THEN/i);
      }
    }
  );

  it.each(['LEAST', 'GREATEST'])('renders %s without unsupported functions or aggregate subqueries', async (name) => {
    const args = ['src.a', 'src.b', 'src.c'];
    const sql = await jinja.renderTemplate(name, {}, { args, args_concat: args.join(', ') });
    expect(sql).not.toMatch(/\b(LEAST|GREATEST|SELECT)\s*\(/i);
    expect(sql).toMatch(/\bCHOOSE\s*\(/i);
    expect(sql).toMatch(/\bCASE\b/i);
  });

  it.each(['LEAST', 'GREATEST'])('%s accepts a single nullable expression', async (name) => {
    const sql = await jinja.renderTemplate(name, {}, { args: ['src.a'], args_concat: 'src.a' });
    expect(sql.trim()).toBe('(src.a)');
  });

  it.each([{ name: 'mysql', Query: MysqlQuery }, { name: 'postgres', Query: PostgresQuery }])('keeps $name aggregation and pagination intact', ({ Query }) => {
    const query = new Query(compilers, {
      measures: ['Sales.amount'],
      dimensions: ['Sales.id'],
      order: [{ id: 'Sales.amount', desc: true }],
      rowLimit: 2,
      offset: 1,
      useNativeSqlPlanner: false,
    });
    const [sql] = query.buildSqlAndParams();
    expect(sql).toMatch(/sum\(/i);
    expect(sql).toMatch(/ORDER BY/i);
    expect(sql).toMatch(/LIMIT\s+2\s+OFFSET\s+1/i);
    expect(sql).not.toMatch(/CHOOSE\(|CASE WHEN .* IS NULL THEN|FETCH NEXT/i);
  });
});
