const fromExports = require('./dist/src');
const { KingbaseOracleDriver } = require('./dist/src/KingbaseOracleDriver');

const toExport = KingbaseOracleDriver;

// eslint-disable-next-line no-restricted-syntax
for (const [key, module] of Object.entries(fromExports)) {
  toExport[key] = module;
}

module.exports = toExport;
