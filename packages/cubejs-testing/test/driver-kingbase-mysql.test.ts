import {
  mainTestSet,
  multiQueryTestSet,
  preAggsTestSet,
  withUnsupportedCountDistinctApprox,
} from './driverTests/testSets';
import { executeTestSuite } from './driver-test-suite';

const kingbaseMysqlConfig = {
  CUBEJS_DB_HOST: process.env.CUBEJS_DB_HOST || '127.0.0.1',
  CUBEJS_DB_PORT: process.env.CUBEJS_DB_PORT || '54323',
  CUBEJS_DB_NAME: process.env.CUBEJS_DB_NAME || 'kingbase',
  CUBEJS_DB_USER: process.env.CUBEJS_DB_USER || 'system',
  CUBEJS_DB_PASS: process.env.CUBEJS_DB_PASS,
};

const skipWithoutPassword = !process.env.CUBEJS_DB_PASS;

executeTestSuite({
  type: 'kingbase-mysql',
  tests: withUnsupportedCountDistinctApprox(mainTestSet),
  config: kingbaseMysqlConfig,
  skip: skipWithoutPassword,
});

executeTestSuite({
  type: 'kingbase-mysql',
  tests: multiQueryTestSet,
  config: kingbaseMysqlConfig,
  skip: skipWithoutPassword,
});

executeTestSuite({
  type: 'kingbase-mysql',
  tests: preAggsTestSet,
  config: {
    ...kingbaseMysqlConfig,
    CUBEJS_EXTERNAL_DEFAULT: 'true',
  },
  skip: skipWithoutPassword,
});
