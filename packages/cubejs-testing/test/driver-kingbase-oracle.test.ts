import {
  mainTestSet,
  multiQueryTestSet,
  preAggsTestSet,
  withUnsupportedCountDistinctApprox,
} from './driverTests/testSets';
import { executeTestSuite } from './driver-test-suite';

const kingbaseOracleConfig = {
  CUBEJS_DB_HOST: process.env.CUBEJS_DB_HOST || '127.0.0.1',
  CUBEJS_DB_PORT: process.env.CUBEJS_DB_PORT || '54321',
  CUBEJS_DB_NAME: process.env.CUBEJS_DB_NAME || 'kingbase',
  CUBEJS_DB_USER: process.env.CUBEJS_DB_USER || 'system',
  CUBEJS_DB_PASS: process.env.CUBEJS_DB_PASS,
};

const skipWithoutPassword = !process.env.CUBEJS_DB_PASS;

executeTestSuite({
  type: 'kingbase-oracle',
  tests: withUnsupportedCountDistinctApprox(mainTestSet),
  config: kingbaseOracleConfig,
  skip: skipWithoutPassword,
});

executeTestSuite({
  type: 'kingbase-oracle',
  tests: multiQueryTestSet,
  config: kingbaseOracleConfig,
  skip: skipWithoutPassword,
});

executeTestSuite({
  type: 'kingbase-oracle',
  tests: preAggsTestSet,
  config: {
    ...kingbaseOracleConfig,
    CUBEJS_EXTERNAL_DEFAULT: 'true',
  },
  skip: skipWithoutPassword,
});
