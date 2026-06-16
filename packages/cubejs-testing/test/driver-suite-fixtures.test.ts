// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { mainTestSet, withUnsupportedCountDistinctApprox } from './driverTests/testSets';

type CastFixture = {
  DB_CAST: Record<string, { SELECT_PREFIX: string; SELECT_SUFFIX: string }>;
  DATE_CAST: Record<string, { DATE_PREFIX: string; DATE_SUFFIX: string }>;
};

function loadCastFixture(): CastFixture {
  const source = fs.readFileSync(
    path.join(__dirname, '../../birdbox-fixtures/driver-test-data/CAST.js'),
    'utf8'
  );

  return vm.runInNewContext(
    `${source.replace(/export const /g, 'const ')}\n({ DB_CAST, DATE_CAST });`,
    {}
  ) as CastFixture;
}

describe('driver-suite Kingbase fixture targets', () => {
  test('maps the Kingbase PG Target to Postgres-compatible fixture casts', () => {
    const { DB_CAST, DATE_CAST } = loadCastFixture();

    expect(DB_CAST['kingbase-pg']).toEqual(DB_CAST.postgres);
    expect(DATE_CAST['kingbase-pg']).toEqual(DATE_CAST.postgres);
  });

  test('maps the Kingbase Oracle Target to Oracle-compatible fixture casts', () => {
    const { DB_CAST, DATE_CAST } = loadCastFixture();

    expect(DB_CAST['kingbase-oracle']).toEqual({
      SELECT_PREFIX: '',
      SELECT_SUFFIX: '',
    });
    expect(DATE_CAST['kingbase-oracle']).toEqual({
      DATE_PREFIX: 'to_date(',
      DATE_SUFFIX: ', \'YYYY-MM-DD\')',
    });
  });

  test('maps the Kingbase MySQL Target to explicit Kingbase-compatible fixture casts', () => {
    const { DB_CAST, DATE_CAST } = loadCastFixture();

    expect(DB_CAST['kingbase-mysql']).toEqual({
      SELECT_PREFIX: '',
      SELECT_SUFFIX: '',
    });
    expect(DATE_CAST['kingbase-mysql']).toEqual({
      DATE_PREFIX: 'CAST(',
      DATE_SUFFIX: ' AS DATE)',
    });
  });
});

describe('driver-suite Kingbase Oracle capability classification', () => {
  test('marks only count distinct approx cases as explicitly unsupported', () => {
    const classifiedTests = withUnsupportedCountDistinctApprox(mainTestSet);
    const countDistinctApproxTests = classifiedTests.filter((driverTest) => (
      driverTest.name.includes('count distinct approx')
    ));
    const changedTests = classifiedTests.filter((driverTest, index) => (
      driverTest.type !== mainTestSet[index].type
    ));

    expect(countDistinctApproxTests).toHaveLength(3);
    expect(countDistinctApproxTests.every((driverTest) => driverTest.type === 'withError')).toEqual(true);
    expect(changedTests.map((driverTest) => driverTest.name)).toEqual(
      countDistinctApproxTests.map((driverTest) => driverTest.name)
    );
  });
});
