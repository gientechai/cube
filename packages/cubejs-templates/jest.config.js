const base = require('../../jest.base-ts.config');

module.exports = {
  ...base,
  rootDir: '.',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
};
