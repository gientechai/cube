import { NativeInstance, registerInterface, shutdownInterface, sql4sql } from '@cubejs-backend/native';
import { MSSqlDriver } from '@cubejs-backend/mssql-driver';
import { MssqlQuery } from '../../../src/adapter/MssqlQuery';
import { prepareJsCompiler } from '../../unit/PrepareCompiler';

// This suite never creates fixtures in the supplied database. It requires an
// explicit connection and only executes SELECTs over existing data or VALUES.
const configured = process.env.MSSQL_COMPAT_HOST && process.env.MSSQL_COMPAT_DATABASE;
const suite = configured ? describe : describe.skip;

suite('MSSQL compatibility against an existing read-only test database', () => {
  let driver: MSSqlDriver;
  const compiler = prepareJsCompiler(`cube('Sales', {
    sql: 'SELECT * FROM (VALUES (1,10),(2,20),(3,NULL),(4,30)) src(id,amount)',
    measures: { amount: { sql: 'amount', type: 'sum' } },
    dimensions: {
      id: { sql: 'id', type: 'number', primaryKey: true, public: true },
      value: { sql: 'amount', type: 'number' }
    }
  });`, { adapter: 'mssql' });
  const jinja = new NativeInstance().newJinjaEngine({ debugInfo: true, filters: {}, workers: 1 });
  const render = (name: string, args: string[]) => jinja.renderTemplate(name, {}, { args, args_concat: args.join(', ') });

  beforeAll(async () => {
    driver = new MSSqlDriver({
      server: process.env.MSSQL_COMPAT_HOST,
      port: Number(process.env.MSSQL_COMPAT_PORT || 1433),
      database: process.env.MSSQL_COMPAT_DATABASE,
      user: process.env.MSSQL_COMPAT_USER,
      password: process.env.MSSQL_COMPAT_PASSWORD,
      options: { encrypt: true, trustServerCertificate: process.env.MSSQL_COMPAT_TRUST_CERT === 'true', useUTC: true },
    });
    const [identity] = await driver.query('SELECT DB_NAME() AS db', []);
    expect(identity.db).toBe(process.env.MSSQL_COMPAT_DATABASE);
    await compiler.compiler.compile();
    const templates = new MssqlQuery(compiler, {}).sqlTemplates();
    for (const name of ['LEAST', 'GREATEST']) {
      jinja.loadTemplate(name, `{% autoescape false %}${templates.functions[name]}{% endautoescape %}`);
    }
    jinja.loadTemplate('sort', `{% autoescape false %}${templates.expressions.sort}{% endautoescape %}`);
    jinja.loadTemplate('select', `{% autoescape false %}${templates.statements.select}{% endautoescape %}`);
  });

  afterAll(async () => { if (driver) await driver.release(); });

  it('uses a database reader with metadata access and no write privileges', async () => {
    const [row] = await driver.query(`SELECT
      HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'SELECT') AS can_read,
      HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS can_describe,
      HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS can_create,
      HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') AS can_insert,
      HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE') AS can_update,
      HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE') AS can_delete`, []);
    expect(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]))).toEqual({
      can_read: 1, can_describe: 1, can_create: 0, can_insert: 0, can_update: 0, can_delete: 0,
    });
  });

  it.each([
    { limit: 2, offset: null, ordered: false, distinct: false, expected: [1, 2] },
    { limit: 2, offset: 1, ordered: false, distinct: false, expected: [2, 3] },
    { limit: 2, offset: null, ordered: false, distinct: true, expected: [1, 2] },
    { limit: 2, offset: 1, ordered: true, distinct: true, expected: [2, 3] },
    { limit: 0, offset: null, ordered: false, distinct: false, expected: [] },
    { limit: 0, offset: 1, ordered: true, distinct: false, expected: [] },
  ])('executes SQL API pagination $limit/$offset with order=$ordered and distinct=$distinct', async (sample) => {
    const sql = await jinja.renderTemplate('select', {}, {
      select_concat: [{ aliased: 'src.id AS id', expr: 'src.id' }],
      from: 'SELECT id FROM (VALUES(1),(2),(3)) input(id)',
      from_alias: 'src',
      ctes: [],
      filter: null,
      group_by: null,
      having: null,
      order_by: sample.ordered ? [{ expr: 'src.id ASC' }] : [],
      ...sample,
    });
    const rows = await driver.query(sql, []);
    const ids = rows.map(r => Number(r.id));
    if (!sample.ordered && sample.offset === null) {
      expect(ids).toHaveLength(sample.expected.length);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every(id => [1, 2, 3].includes(id))).toBe(true);
    } else {
      expect(ids).toEqual(sample.expected);
    }
  });

  it.each(['LEAST', 'GREATEST'])('%s matches common-type MIN/MAX for values and NULLs', async (name) => {
    for (const args of [
      ['NULL'], ['NULL', 'NULL'], ['1', '2', '3'],
      ['NULL', '2.5', '-1.25'], ['\'2\'', '\'11\'', '100'],
      ['N\'甲\'', 'N\'乙\'', 'NULL'], ['5', '5'],
      ['CAST(1.234 AS decimal(10,3))', 'CAST(1.2 AS decimal(5,1))'],
      Array.from({ length: 12 }, (_, i) => String(12 - i)),
    ]) {
      const expression = await render(name, args);
      const aggregate = name === 'LEAST' ? 'MIN' : 'MAX';
      // SQL Server cannot MIN/MAX an untyped NULL column, but the scalar result is NULL.
      const reference = args.every(arg => arg === 'NULL') ? 'CAST(NULL AS int)'
        : `(SELECT ${aggregate}(v) FROM (VALUES ${args.map(a => `(${a})`).join(',')}) reference(v))`;
      const [row] = await driver.query(`SELECT ${expression} AS actual, ${reference} AS expected`, []);
      expect(row.actual).toEqual(row.expected);
    }
  });

  it.each(['LEAST', 'GREATEST'])('%s works both inside and outside aggregate functions', async (name) => {
    const rowExpr = await render(name, ['src.a', 'src.b']);
    const groupExpr = await render(name, ['SUM(src.a)', 'SUM(src.b)']);
    const [row] = await driver.query(`SELECT SUM(${rowExpr}) AS row_total, ${groupExpr} AS group_value
      FROM (VALUES (1,10),(20,2),(NULL,3),(NULL,NULL)) src(a,b)`, []);
    expect(Number(row.row_total)).toBe(name === 'LEAST' ? 6 : 33);
    expect(Number(row.group_value)).toBe(name === 'LEAST' ? 15 : 21);
  });

  it.each([[true, true], [false, false], [true, false], [false, true]])(
    'executes NULL ordering and DISTINCT/grouped source projections (asc=%s, first=%s)',
    async (asc, nullsFirst) => {
      const order = await jinja.renderTemplate('sort', {}, { expr: 'src.v', asc, nulls_first: nullsFirst });
      const rows = await driver.query(`SELECT src.v FROM
        (SELECT DISTINCT v FROM (VALUES(2),(1),(NULL),(1)) input(v)) src ORDER BY ${order}`, []);
      const values: Array<number | null> = asc ? [1, 2] : [2, 1];
      if (nullsFirst) values.unshift(null); else values.push(null);
      expect(rows.map(r => (r.v === null ? null : Number(r.v)))).toEqual(values);
    }
  );

  it.each([false, true])('executes generated aggregation and pagination (Tesseract=%s)', async (useNativeSqlPlanner) => {
    const query = new MssqlQuery(compiler, {
      dimensions: ['Sales.id'],
      measures: ['Sales.amount'],
      order: [{ id: 'Sales.amount', desc: false }, { id: 'Sales.id', desc: true }],
      rowLimit: 2,
      offset: 1,
      useNativeSqlPlanner,
    });
    const [sql, params] = query.buildSqlAndParams();
    const rows = await driver.query(sql, params);
    expect(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])))).toEqual([
      { sales__id: 1, sales__amount: 10 }, { sales__id: 2, sales__amount: 20 },
    ]);
  });

  it.each([
    { native: false, desc: false, ids: [1, 4, 2, 3, 6, 5] },
    { native: true, desc: false, ids: [1, 4, 2, 3, 6, 5] },
    { native: false, desc: true, ids: [5, 2, 3, 6, 1, 4] },
    { native: true, desc: true, ids: [5, 2, 3, 6, 1, 4] },
  ])('pages tied values and NULLs without omissions or duplicates (native=$native, desc=$desc)', async (sample) => {
    const pagingCompiler = prepareJsCompiler(`cube('Paging', {
      sql: 'SELECT * FROM (VALUES(1,NULL),(2,10),(3,10),(4,NULL),(5,20),(6,10)) src(id,amount)',
      measures: { amount: { sql: 'amount', type: 'sum' } },
      dimensions: { id: { sql: 'id', type: 'number', primaryKey: true } }
    });`, { adapter: 'mssql' });
    await pagingCompiler.compiler.compile();
    const ids: number[] = [];
    for (const offset of [0, 2, 4, 6]) {
      const query = new MssqlQuery(pagingCompiler, {
        dimensions: ['Paging.id'],
        measures: ['Paging.amount'],
        order: [{ id: 'Paging.amount', desc: sample.desc }, { id: 'Paging.id', desc: false }],
        rowLimit: 2,
        offset,
        useNativeSqlPlanner: sample.native,
      });
      const [sql, params] = query.buildSqlAndParams();
      const page = await driver.query(sql, params);
      expect(page).toHaveLength(offset < 6 ? 2 : 0);
      ids.push(...page.map(row => Number(row.paging__id)));
    }
    expect(ids).toEqual(sample.ids);
    expect(new Set(ids).size).toBe(6);
  });

  it('executes actual native SQL API pushdown for comparison, aliases and NULL pagination', async () => {
    // In-process compiler transport only: no HTTP/PG listener or auth bypass.
    const unavailable = async () => { throw new Error('Generation-only test transport'); };
    const instance = await registerInterface({
      checkAuth: unavailable,
      checkSqlAuth: unavailable,
      canSwitchUserForSession: async () => false,
      contextToApiScopes: async () => ['data', 'meta'],
      load: unavailable,
      stream: unavailable,
      sqlApiLoad: unavailable,
      logLoadEvent: async () => undefined,
      meta: async () => ({
        cubes: compiler.metaTransformer.cubes.map(c => c.config),
        compilerId: '00000000-0000-4000-8000-000000000001',
      }),
      sqlGenerators: async () => ({
        memberToDataSource: { 'Sales.id': 'default', 'Sales.value': 'default', 'Sales.amount': 'default' },
        dataSourceToSqlGenerator: { default: new MssqlQuery(compiler, {}) },
      }),
      sql: async ({ query, memberToAlias, expressionParams }) => {
        // These pushdown cases request ordinary members from the inner scan.
        expect([...(query.dimensions || []), ...(query.measures || [])].every(m => !m.startsWith('{'))).toBe(true);
        const order = Array.isArray(query.order) ? query.order : Object.entries(query.order || {});
        const inner = new MssqlQuery(compiler, {
          ...query,
          memberToAlias,
          expressionParams,
          rowLimit: query.limit,
          order: order.map(([id, direction]) => ({ id, desc: direction === 'desc' })),
          useNativeSqlPlanner: false,
        });
        return { sql: { sql: inner.buildSqlAndParams(true), aliasNameToMember: inner.aliasNameToMember }, dataSource: 'default' };
      },
    });
    try {
      const run = async (query: string) => {
        const result = await sql4sql(instance, query, true, {});
        expect(result).toMatchObject({ status: 'ok', query_type: 'pushdown' });
        const [sql, values] = (result as unknown as { sql: [string, string[]] }).sql;
        return driver.query(sql, values);
      };
      expect(await run('SELECT LEAST(SUM(amount),15) AS lo, GREATEST(SUM(amount),15) AS hi FROM Sales'))
        .toEqual([{ lo: '15', hi: '60' }]);
      const ordered = await run('SELECT value, SUM(amount)+1 AS total FROM Sales GROUP BY value ORDER BY total ASC NULLS LAST');
      expect(ordered.map(r => r.total)).toEqual(['11', '21', '31', null]);
      const page = await run('SELECT id, SUM(amount)+1 AS total FROM Sales GROUP BY id ORDER BY total DESC NULLS FIRST, id ASC LIMIT 2 OFFSET 1');
      expect(page.map(r => r.id)).toEqual(['4', '2']);
    } finally { await shutdownInterface(instance, 'fast'); }
  });
});
