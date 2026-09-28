// Compare stdout from this generation-only probe under baseline/patched native
// modules. No listener, authentication bypass, or database connection is used.
const assert = require('node:assert/strict');
const { registerInterface, shutdownInterface, sql4sql } = require('@cubejs-backend/native');
const { ApiGateway } = require('@cubejs-backend/api-gateway');
const { getEnv } = require('@cubejs-backend/shared');
const { prepareCompiler } = require('@cubejs-backend/schema-compiler/dist/src/compiler/PrepareCompiler');
const { PostgresQuery } = require('@cubejs-backend/schema-compiler/dist/src/adapter/PostgresQuery');
const { MysqlQuery } = require('@cubejs-backend/schema-compiler/dist/src/adapter/MysqlQuery');
const { MssqlQuery } = require('@cubejs-backend/schema-compiler/dist/src/adapter/MssqlQuery');

(async () => {
  const results = [];
  for (const [dialect, Query] of [['postgres', PostgresQuery], ['mysql', MysqlQuery]]) {
    const content = ['Sales', 'SqlServerSales'].map(name => `cube('${name}', {
      sql: 'SELECT id, amount FROM sales', data_source: '${name === 'Sales' ? 'default' : 'mssql'}',
      measures: { amount: { sql: 'amount', type: 'sum' } },
      dimensions: {
        id: { sql: 'id', type: 'number', primaryKey: true, public: true },
        value: { sql: 'amount', type: 'number' }
      }
    });`).join('\n');
    const compiler = prepareCompiler({
      localPath: () => __dirname,
      dataSchemaFiles: async () => [{ fileName: 'sales.js', content }],
    }, { adapter: dialect });
    await compiler.compiler.compile();
    assert.equal(new Query(compiler, {}).sqlTemplates().capabilities?.mssql_2016_compat, undefined);
    const unavailable = async () => { throw new Error('Generation-only transport'); };
    const instance = await registerInterface({
      checkAuth: unavailable, checkSqlAuth: unavailable,
      canSwitchUserForSession: async () => false,
      contextToApiScopes: async () => ['data', 'meta'],
      load: unavailable, stream: unavailable, sqlApiLoad: unavailable,
      logLoadEvent: async () => undefined,
      meta: async () => ({ cubes: compiler.metaTransformer.cubes.map(c => c.config), compilerId: '00000000-0000-4000-8000-000000000006' }),
      sqlGenerators: async () => ({
        memberToDataSource: Object.fromEntries(['Sales', 'SqlServerSales'].flatMap(name =>
          ['id', 'value', 'amount'].map(member => [`${name}.${member}`, name === 'Sales' ? 'default' : 'mssql']))),
        dataSourceToSqlGenerator: { default: new Query(compiler, {}), mssql: new MssqlQuery(compiler, {}) },
      }),
      sql: async ({ query, memberToAlias, expressionParams }) => {
        const gateway = ApiGateway.prototype;
        query = gateway.evalMemberExpressionsInQuery(gateway.parseMemberExpressionsInQuery(query));
        const order = Array.isArray(query.order) ? query.order : Object.entries(query.order || {});
        const inner = new Query(compiler, {
          ...query, memberToAlias, expressionParams,
          allowUngroupedWithoutPrimaryKey: getEnv('allowUngroupedWithoutPrimaryKey'),
          rowLimit: query.limit,
          order: order.map(([id, direction]) => ({ id, desc: direction === 'desc' })),
          useNativeSqlPlanner: false,
        });
        return { sql: { sql: inner.buildSqlAndParams(true), aliasNameToMember: inner.aliasNameToMember }, dataSource: 'default' };
      },
    });
    try {
      const queries = [];
      for (const direction of ['ASC', 'DESC']) {
        for (const nulls of ['FIRST', 'LAST']) {
          for (const [select, group, sort] of [
            ['id, value', '', 'value'],
            ['id, SUM(amount) AS total', 'GROUP BY id', 'total'],
            ['id, SUM(amount)+1 AS total', 'GROUP BY id', 'total'],
          ]) {
            queries.push(`SELECT ${select} FROM Sales ${group} ORDER BY ${sort} ${direction} NULLS ${nulls}, id ASC LIMIT 2 OFFSET 1`);
          }
          queries.push(`SELECT DISTINCT value FROM Sales ORDER BY value ${direction} NULLS ${nulls}`);
        }
      }
      queries.push('SELECT LEAST(SUM(amount),15) AS lo, GREATEST(SUM(amount),15) AS hi FROM Sales');
      queries.push('SELECT id FROM Sales WHERE value > 10 ORDER BY id LIMIT 0');
      for (const query of queries) {
        const result = await sql4sql(instance, query, true, {});
        if (result.status === 'ok') {
          assert.doesNotMatch(result.sql[0], /mssql_null_order|CHOOSE\(/);
        }
        results.push({ dialect, query, result });
      }
      for (const query of [
        'SELECT LEAST() FROM Sales',
        'SELECT GREATEST()',
        'SELECT LEAST() FROM Sales CROSS JOIN SqlServerSales',
        'WITH SqlServerSales AS (SELECT id FROM Sales) SELECT LEAST() FROM SqlServerSales',
      ]) {
        const error = await sql4sql(instance, query, true, {}).then(r => r.error || '', e => e.message);
        assert.ok(error);
        assert.doesNotMatch(error, /requires at least one argument/);
        results.push({ dialect, query, errorKind: /panic|Deferred.*dropped/.test(error) ? 'legacy-udf-error' : error });
      }
    } finally {
      await shutdownInterface(instance, 'fast');
    }
  }
  assert.ok(results.filter(item => item.result?.status === 'ok').length >= 30);
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
