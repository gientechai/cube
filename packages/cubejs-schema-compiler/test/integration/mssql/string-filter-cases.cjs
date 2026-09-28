/* Generate real-planner SQL and independent expected rows without writing a database.
 * Usage: node string-filter-cases.cjs <output.json> [baseline-MssqlQuery.js]
 * Execute the MSSQL queries with a read-only driver and compare returned labels__id.
 * The optional baseline module is loaded in memory; no installed files are replaced.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const assert = require('assert/strict');

const root = path.resolve(__dirname, '../../..');
const adapterPath = path.join(root, 'dist/src/adapter/MssqlQuery.js');
if (process.argv[3]) {
  const baseline = new Module(adapterPath, module);
  baseline.filename = adapterPath;
  baseline.paths = Module._nodeModulePaths(path.dirname(adapterPath));
  baseline._compile(fs.readFileSync(process.argv[3], 'utf8'), adapterPath);
  require.cache[adapterPath] = baseline;
}
const { MssqlQuery } = require('../../../dist/src/adapter/MssqlQuery');
const { PostgresQuery } = require('../../../dist/src/adapter/PostgresQuery');
const { MysqlQuery } = require('../../../dist/src/adapter/MysqlQuery');
const { prepareJsCompiler } = require('../../../dist/test/unit/PrepareCompiler');

const values = ['Alpha南自', 'alpha河海', 'beta南自', 'a%b', 'a_b', 'a[b', 'a]b', 'O\'Neil', 'path\\name', null, 'ALPHA', '', 'axb'];
const tupleSql = values.map((v, i) => `(${i + 1},${v === null ? 'NULL' : `N'${v.replace(/'/g, '\'\'')}'`})`).join(',');
const schema = `cube('Labels', {
  sql: ${JSON.stringify(`SELECT id, label COLLATE Latin1_General_100_CS_AS AS label FROM (VALUES ${tupleSql}) src(id,label)`)},
  measures: { count: { type: 'count' } },
  dimensions: {
    id: { sql: 'id', type: 'number', primaryKey: true, public: true },
    label: { sql: 'label', type: 'string' }
  }
});`;
const cases = [
  ['contains', ['alpha'], [1, 2, 11]],
  ['notContains', ['alpha'], [3, 4, 5, 6, 7, 8, 9, 10, 12, 13]],
  ['startsWith', ['ALPHA'], [1, 2, 11]],
  ['notStartsWith', ['ALPHA'], [3, 4, 5, 6, 7, 8, 9, 10, 12, 13]],
  ['endsWith', ['南自'], [1, 3]],
  ['notEndsWith', ['南自'], [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]],
  ['contains', ['%'], [4]],
  ['contains', ['_'], [5]],
  ['contains', ['['], [6]],
  ['contains', [']'], [7]],
  ['contains', ['O\'Neil'], [8]],
  ['contains', ['\\'], [9]],
  ['contains', ['alpha', '南自'], [1, 2, 3, 11]],
  ['notContains', ['alpha', '南自'], [4, 5, 6, 7, 8, 9, 10, 12, 13]],
  ['contains', ['alpha', null], [1, 2, 10, 11]],
  ['notContains', ['alpha', null], [3, 4, 5, 6, 7, 8, 9, 12, 13]],
  ['contains', [''], [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13]],
  ['contains', ['不存在'], []],
];
(async () => {
  const compilers = prepareJsCompiler(schema, { adapter: 'mssql' });
  await compilers.compiler.compile();
  const output = [];
  for (const [dialect, Query] of [['mssql', MssqlQuery], ['postgres', PostgresQuery], ['mysql', MysqlQuery]]) {
    for (const native of [false, true]) {
      for (const [index, [operator, filterValues, expected]] of cases.entries()) {
        const options = {
          dimensions: ['Labels.id'],
          ungrouped: true,
          filters: [{ member: 'Labels.label', operator, values: filterValues }],
          order: [{ id: 'Labels.id', desc: false }],
          useNativeSqlPlanner: native,
          timezone: 'UTC',
        };
        const [sql, params] = new Query(compilers, options).buildSqlAndParams();
        output.push({ dialect, native, index, operator, values: filterValues, sql, params, expected });
      }
      const [sql, params] = new Query(compilers, {
        measures: ['Labels.count'],
        filters: [{ or: [
          { member: 'Labels.label', operator: 'contains', values: ['alpha'] },
          { member: 'Labels.label', operator: 'endsWith', values: ['南自'] },
        ] }],
        useNativeSqlPlanner: native,
        timezone: 'UTC',
      }).buildSqlAndParams();
      output.push({ dialect, native, index: cases.length, sql, params, expectedCount: 4 });
    }
  }
  assert.equal(output.length, 114);
  fs.writeFileSync(process.argv[2], `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Generated ${output.length} planner cases.`);
})().catch(e => { console.error(e); process.exitCode = 1; });
