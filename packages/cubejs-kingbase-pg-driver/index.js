const fromExports = require('./dist/src');
const { KingbasePgDriver } = require('./dist/src/KingbasePgDriver');

const toExport = KingbasePgDriver;

// eslint-disable-next-line no-restricted-syntax
for (const [key, module] of Object.entries(fromExports)) {
  toExport[key] = module;
}

module.exports = toExport;
