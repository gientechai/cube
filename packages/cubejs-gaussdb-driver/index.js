const fromExports = require('./dist/src');
const { GaussDBDriver } = require('./dist/src/GaussDBDriver');

const toExport = GaussDBDriver;

// eslint-disable-next-line no-restricted-syntax
for (const [key, module] of Object.entries(fromExports)) {
  toExport[key] = module;
}

module.exports = toExport;
