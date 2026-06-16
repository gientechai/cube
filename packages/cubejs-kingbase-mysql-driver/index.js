const fromExports = require('./dist/src');
const { KingbaseMysqlDriver } = require('./dist/src/KingbaseMysqlDriver');

const toExport = KingbaseMysqlDriver;

// eslint-disable-next-line no-restricted-syntax
for (const [key, module] of Object.entries(fromExports)) {
  toExport[key] = module;
}

module.exports = toExport;
