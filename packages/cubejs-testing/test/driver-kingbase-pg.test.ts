import { mainTestSet, multiQueryTestSet, preAggsTestSet } from './driverTests/testSets';
import { executeTestSuite } from './driver-test-suite';

const kingbasePgConfig = {
  CUBEJS_DB_HOST: process.env.CUBEJS_DB_HOST || '127.0.0.1',
  CUBEJS_DB_PORT: process.env.CUBEJS_DB_PORT || '54322',
  CUBEJS_DB_NAME: process.env.CUBEJS_DB_NAME || 'kingbase',
  CUBEJS_DB_USER: process.env.CUBEJS_DB_USER || 'system',
  CUBEJS_DB_PASS: process.env.CUBEJS_DB_PASS,
};

executeTestSuite({
  type: 'kingbase-pg',
  tests: mainTestSet,
  config: kingbasePgConfig,
});

executeTestSuite({
  type: 'kingbase-pg',
  tests: multiQueryTestSet,
  config: kingbasePgConfig,
});

executeTestSuite({
  type: 'kingbase-pg',
  tests: preAggsTestSet,
  config: {
    ...kingbasePgConfig,
    CUBEJS_EXTERNAL_DEFAULT: 'true',
  },
});
