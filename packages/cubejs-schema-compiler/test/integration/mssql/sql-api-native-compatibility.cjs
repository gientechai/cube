// Run with Node 22 --test against the matching compiled adapter and native module.
// This creates no listener or database fixtures; the supplied SQL login must be read-only.
/* eslint-disable import/no-extraneous-dependencies -- Runs against the deployed Cube dependency layout. */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { registerInterface, shutdownInterface, sql4sql } = require('@cubejs-backend/native');
const { MSSqlDriver } = require('@cubejs-backend/mssql-driver');
const { ApiGateway } = require('@cubejs-backend/api-gateway');
const { getEnv } = require('@cubejs-backend/shared');
const { MssqlQuery } = require('@cubejs-backend/schema-compiler/dist/src/adapter/MssqlQuery');
const { CompilerApi } = require('@cubejs-backend/server-core/dist/src/core/CompilerApi');

test('native SQL API preserves MSSQL NULL order and rejects empty arguments', {
  skip: !process.env.MSSQL_COMPAT_HOST || !process.env.MSSQL_COMPAT_DATABASE,
}, async (t) => {
  const e = process.env;
  const driver = new MSSqlDriver({
    server: e.MSSQL_COMPAT_HOST,
    port: Number(e.MSSQL_COMPAT_PORT || 1433),
    database: e.MSSQL_COMPAT_DATABASE,
    user: e.MSSQL_COMPAT_USER,
    password: e.MSSQL_COMPAT_PASSWORD,
    options: { encrypt: true, trustServerCertificate: e.MSSQL_COMPAT_TRUST_CERT === 'true' },
  });
  let instance;
  let compilerApi;
  const previousPlanner = process.env.CUBEJS_TESSERACT_SQL_PLANNER;
  process.env.CUBEJS_TESSERACT_SQL_PLANNER = 'true';
  try {
    const [identity] = await driver.query('SELECT DB_NAME() AS db', []);
    assert.equal(identity.db, e.MSSQL_COMPAT_DATABASE);
    compilerApi = new CompilerApi({
      localPath: () => __dirname,
      dataSchemaFiles: async () => [{ fileName: 'sales.js', content: `cube('Sales', {
        data_source: 'sqlserver_compat',
        sql: 'SELECT * FROM (VALUES(1,10),(2,NULL),(3,10),(4,20),(5,NULL),(6,20)) src(id,amount)',
        joins: { PeerSales: { sql: \`\${CUBE}.id = \${PeerSales}.id\`, relationship: 'many_to_one' } },
        measures: { amount: { sql: 'amount', type: 'sum' } },
        dimensions: {
          id: { sql: 'id', type: 'number', primaryKey: true, public: true },
          value: { sql: 'amount', type: 'number' }
        }
      });
      cube('PeerSales', {
        data_source: 'sqlserver_compat',
        sql: 'SELECT * FROM (VALUES(1,10),(2,NULL),(3,10),(4,20),(5,NULL),(6,20)) src(id,amount)',
        dimensions: {
          id: { sql: 'id', type: 'number', primaryKey: true, public: true },
          value: { sql: 'amount', type: 'number' }
        }
      });` }],
    }, async ({ dataSource }) => (dataSource === 'sqlserver_compat' ? 'mssql' : 'postgres'), {
      allowUngroupedWithoutPrimaryKey: getEnv('allowUngroupedWithoutPrimaryKey'),
      externalDbType: 'cubestore',
    });
    const compiler = await compilerApi.getCompilers();
    const unavailable = async () => { throw new Error('In-process generation-only test transport'); };
    instance = await registerInterface({
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
        compilerId: '00000000-0000-4000-8000-000000000005',
      }),
      sqlGenerators: async () => ({
        memberToDataSource: Object.fromEntries(['Sales.id', 'Sales.value', 'Sales.amount', 'PeerSales.id', 'PeerSales.value'].map(member => [member, 'sqlserver_compat'])),
        dataSourceToSqlGenerator: { sqlserver_compat: new MssqlQuery(compiler, {}) },
      }),
      sql: async ({ query, memberToAlias, expressionParams }) => {
        // Match the production gateway's handling of expressions emitted by
        // wrapped SQL plans before passing the query to the schema compiler.
        const gateway = ApiGateway.prototype;
        query = gateway.evalMemberExpressionsInQuery(gateway.parseMemberExpressionsInQuery(query));
        const order = Array.isArray(query.order) ? query.order : Object.entries(query.order || {});
        const inner = await compilerApi.getSql({
          ...query,
          memberToAlias,
          expressionParams,
          contextSymbols: { securityContext: {} },
          rowLimit: query.limit,
          order: order.map(([id, direction]) => ({ id, desc: direction === 'desc' })),
        }, { exportAnnotatedSql: true });
        return { sql: { sql: inner.sql, aliasNameToMember: inner.aliasNameToMember }, dataSource: inner.dataSource };
      },
    });
    const run = async (query) => {
      const result = await sql4sql(instance, query, true, {});
      assert.equal(result.status, 'ok', JSON.stringify(result));
      assert.ok(['regular', 'pushdown'].includes(result.query_type));
      const [sql, params] = result.sql;
      assert.doesNotMatch(sql, /IS NULL\s+(ASC|DESC)/i);
      return driver.query(sql, params);
    };
    for (const [direction, nulls, expected] of [
      ['ASC', 'FIRST', [2, 5, 1, 3, 4, 6]],
      ['ASC', 'LAST', [1, 3, 4, 6, 2, 5]],
      ['DESC', 'FIRST', [2, 5, 4, 6, 1, 3]],
      ['DESC', 'LAST', [4, 6, 1, 3, 2, 5]],
    ]) {
      for (const [name, select, group, sort] of [
        ['ordinary members', 'id, value', '', 'value'],
        ['aggregate alias', 'id, SUM(amount) AS total', 'GROUP BY id', 'total'],
        ['pushdown expression', 'id, SUM(amount)+1 AS total', 'GROUP BY id', 'total'],
      ]) {
        await t.test(`${name}: ${direction} NULLS ${nulls}, ties and consecutive pages`, async () => {
          const ids = [];
          for (const offset of [0, 2, 4, 6]) {
            const rows = await run(`SELECT ${select} FROM Sales ${group} ORDER BY ${sort} ${direction} NULLS ${nulls}, id ASC LIMIT 2 OFFSET ${offset}`);
            assert.equal(rows.length, offset < 6 ? 2 : 0);
            ids.push(...rows.map(row => Number(row.id)));
          }
          assert.deepEqual(ids, expected);
          assert.equal(new Set(ids).size, 6);
        });
      }
      await t.test(`DISTINCT: ${direction} NULLS ${nulls}`, async () => {
        const rows = await run(`SELECT DISTINCT value FROM Sales ORDER BY value ${direction} NULLS ${nulls}`);
        const values = direction === 'ASC' ? [10, 20] : [20, 10];
        const expectedValues = nulls === 'FIRST' ? [null, ...values] : [...values, null];
        assert.deepEqual(rows.map(row => (row.value === null ? null : Number(row.value))), expectedValues);
      });
    }
    await t.test('nonempty comparison aggregate remains correct', async () => {
      const rows = await run('SELECT LEAST(SUM(amount),15) AS lo, GREATEST(SUM(amount),15) AS hi FROM Sales');
      assert.deepEqual(rows.map(row => [Number(row.lo), Number(row.hi)]), [[15, 60]]);
    });
    await t.test('comparison inside an aggregate accepts SQL API expression measures', async () => {
      const rows = await run('SELECT SUM(LEAST(value,15)) AS lo, SUM(GREATEST(value,15)) AS hi FROM Sales');
      assert.deepEqual(rows.map(row => [Number(row.lo), Number(row.hi)]), [[80, 100]]);
    });
    await t.test('nested comparison around aggregates preserves requested aliases', async () => {
      const rows = await run('SELECT LEAST(GREATEST(SUM(amount),15),50) AS v FROM Sales');
      assert.equal(Number(rows[0].v), 50);
    });
    await t.test('comparison over a joined SQL API query remains executable', async () => {
      const rows = await run('SELECT a.id, LEAST(a.value,b.value) AS v FROM Sales a LEFT JOIN PeerSales b ON a.__cubeJoinField=b.__cubeJoinField ORDER BY a.id LIMIT 3');
      assert.deepEqual(rows.map(row => [Number(row.id), row.v === null ? null : Number(row.v)]), [[1, 10], [2, null], [3, 10]]);
    });
    for (const name of ['LEAST', 'GREATEST']) {
      await t.test(`${name}() returns an argument error and leaves the interface usable`, async () => {
        const error = await sql4sql(instance, `SELECT ${name}() FROM Sales`, true, {})
          .then(result => result.error || '', failure => failure.message);
        assert.match(error, /requires at least one argument/);
        assert.doesNotMatch(error, /panic|Deferred.*dropped|Cannot resolve/);
        assert.equal(Number((await run('SELECT id FROM Sales ORDER BY id LIMIT 1'))[0].id), 1);
      });
    }
    for (const query of [
      'SELECT "least"() FROM Sales',
      'SELECT id FROM Sales ORDER BY GREATEST()',
      'SELECT LEAST() FROM (SELECT id FROM Sales) s',
      'WITH s AS (SELECT id FROM Sales) SELECT GREATEST() FROM s',
      'WITH Sales AS (SELECT id FROM Sales) SELECT LEAST() FROM Sales',
    ]) {
      await t.test(`MSSQL validation resolves the query scope: ${query}`, async () => {
        const error = await sql4sql(instance, query, true, {}).then(result => result.error || '', failure => failure.message);
        assert.match(error, /requires at least one argument/);
        assert.doesNotMatch(error, /panic|Deferred.*dropped/);
      });
    }
  } finally {
    if (instance) await shutdownInterface(instance, 'fast');
    if (compilerApi) compilerApi.dispose();
    if (previousPlanner === undefined) delete process.env.CUBEJS_TESSERACT_SQL_PLANNER;
    else process.env.CUBEJS_TESSERACT_SQL_PLANNER = previousPlanner;
    await driver.release();
  }
});
