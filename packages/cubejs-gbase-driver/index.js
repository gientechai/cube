const fromExports = require('./dist/src');
const { GBaseDriver } = require('./dist/src/GBaseDriver');

const toExport = GBaseDriver;

// eslint-disable-next-line no-restricted-syntax
for (const [key, module] of Object.entries(fromExports)) {
  toExport[key] = module;
}

module.exports = toExport;
