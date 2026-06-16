// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, test } from '@jest/globals';
import { driverTestName } from './driver-test-suite';

describe('driver-suite test names', () => {
  test('redacts sensitive config values while preserving target context', () => {
    const testName = driverTestName('loads customers', {
      CUBEJS_DB_TYPE: 'kingbase-oracle',
      CUBEJS_DB_HOST: '127.0.0.1',
      CUBEJS_DB_PASS: 'actual-password',
      KINGBASE_ORACLE_PASSWORD: 'oracle-password',
      API_TOKEN: 'raw-token',
      CUBEJS_EXTERNAL_DEFAULT: 'false',
    });

    expect(testName).toContain('loads customers_');
    expect(testName).toContain('"CUBEJS_DB_TYPE":"kingbase-oracle"');
    expect(testName).toContain('"CUBEJS_EXTERNAL_DEFAULT":"false"');
    expect(testName).toContain('"CUBEJS_DB_PASS":"[REDACTED]"');
    expect(testName).toContain('"KINGBASE_ORACLE_PASSWORD":"[REDACTED]"');
    expect(testName).toContain('"API_TOKEN":"[REDACTED]"');
    expect(testName).not.toContain('actual-password');
    expect(testName).not.toContain('oracle-password');
    expect(testName).not.toContain('raw-token');
  });
});
