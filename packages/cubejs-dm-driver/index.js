const fromExports = require("./dist/src");
const { DmDriver } = require("./dist/src/DmDriver");

const toExport = DmDriver;

// eslint-disable-next-line no-restricted-syntax
for (const [key, module] of Object.entries(fromExports)) {
  toExport[key] = module;
}

module.exports = toExport;
