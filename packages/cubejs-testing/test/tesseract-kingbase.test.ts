import cubejs, { CubeApi, Query } from '@cubejs-client/core';
// eslint-disable-next-line import/no-extraneous-dependencies
import { afterAll, beforeAll, describe, expect, jest } from '@jest/globals';
import { BirdBox, DriverType, getBirdbox } from '../src';
import {
  DEFAULT_API_TOKEN,
  DEFAULT_CONFIG,
  JEST_AFTER_ALL_DEFAULT_TIMEOUT,
  JEST_BEFORE_ALL_DEFAULT_TIMEOUT,
} from './smoke-tests';

type TesseractTarget = {
  type: DriverType;
  port: string;
  envPrefix: 'KINGBASE_PG' | 'KINGBASE_ORACLE';
  schemaDir: string;
  cubejsConfig: string;
};

function normalizeRows(rows: Record<string, any>[]) {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !key.endsWith('.createdAt'))
      .map(([key, value]) => {
        const stringValue = typeof value === 'number' ? `${value}` : value;
        return [
          key,
          typeof stringValue === 'string' && /^-?\d+\.0+$/.test(stringValue)
            ? stringValue.replace(/\.0+$/, '')
          : stringValue,
        ];
      })
  )).filter((row) => Object.entries(row).some(([key, value]) => (
    key.includes('.') && !key.endsWith('.day') && value !== null
  )));
}

async function loadRows(client: CubeApi, query: Query) {
  const result = await client.load(query);
  return normalizeRows(result.rawData());
}

function runKingbaseTesseractSuite({
  type,
  port,
  envPrefix,
  schemaDir,
  cubejsConfig,
}: TesseractTarget) {
  const hasPassword = !!process.env.CUBEJS_DB_PASS;
  const describeIf = hasPassword ? describe : describe.skip;

  describeIf(`${type} Tesseract real-database tests`, () => {
    jest.setTimeout(60 * 5 * 1000);
    let birdbox: BirdBox;
    let client: CubeApi;

    beforeAll(async () => {
      birdbox = await getBirdbox(
        type,
        {
          ...DEFAULT_CONFIG,
          CUBEJS_DB_HOST: process.env[`${envPrefix}_HOST`] || process.env.CUBEJS_DB_HOST || '127.0.0.1',
          CUBEJS_DB_PORT: process.env[`${envPrefix}_PORT`] || port,
          CUBEJS_DB_NAME: process.env[`${envPrefix}_DATABASE`] || process.env.CUBEJS_DB_NAME || 'kingbase',
          CUBEJS_DB_USER: process.env[`${envPrefix}_USER`] || process.env.CUBEJS_DB_USER || 'system',
          CUBEJS_DB_PASS: process.env[`${envPrefix}_PASSWORD`] || process.env.CUBEJS_DB_PASS,
          CUBEJS_EXTERNAL_DEFAULT: 'false',
          CUBEJS_TESSERACT_SQL_PLANNER: 'true',
        },
        {
          schemaDir,
          cubejsConfig,
        }
      );
      client = cubejs(async () => DEFAULT_API_TOKEN, {
        apiUrl: birdbox.configuration.apiUrl,
      });
    }, JEST_BEFORE_ALL_DEFAULT_TIMEOUT);

    afterAll(async () => {
      await birdbox.stop();
    }, JEST_AFTER_ALL_DEFAULT_TIMEOUT);

    test('uses the shared deterministic fixture through the public Cube API', async () => {
      await expect(loadRows(client, {
        measures: ['Orders.totalAmount'],
        dimensions: ['Orders.source', 'Orders.currency', 'Orders.category'],
        order: {
          'Orders.source': 'asc',
          'Orders.currency': 'asc',
          'Orders.category': 'asc',
        },
      })).resolves.toEqual([
        { 'Orders.source': 'partner', 'Orders.currency': 'EUR', 'Orders.category': 'software', 'Orders.totalAmount': '600' },
        { 'Orders.source': 'partner', 'Orders.currency': 'USD', 'Orders.category': 'hardware', 'Orders.totalAmount': '500' },
        { 'Orders.source': 'store', 'Orders.currency': 'EUR', 'Orders.category': 'software', 'Orders.totalAmount': '400' },
        { 'Orders.source': 'store', 'Orders.currency': 'USD', 'Orders.category': 'software', 'Orders.totalAmount': '300' },
        { 'Orders.source': 'web', 'Orders.currency': 'EUR', 'Orders.category': 'hardware', 'Orders.totalAmount': '200' },
        { 'Orders.source': 'web', 'Orders.currency': 'USD', 'Orders.category': 'hardware', 'Orders.totalAmount': '100' },
      ]);
    });

    test('evaluates rolling windows with explicit date ranges', async () => {
      await expect(loadRows(client, {
        measures: ['Orders.rollingTwoDayAmount'],
        timeDimensions: [{
          dimension: 'Orders.createdAt',
          granularity: 'day',
          dateRange: ['2024-01-01', '2024-01-05'],
        }],
        order: { 'Orders.createdAt.day': 'asc' },
      })).resolves.toEqual([
        { 'Orders.createdAt.day': '2024-01-01T00:00:00.000', 'Orders.rollingTwoDayAmount': '100' },
        { 'Orders.createdAt.day': '2024-01-02T00:00:00.000', 'Orders.rollingTwoDayAmount': '300' },
        { 'Orders.createdAt.day': '2024-01-03T00:00:00.000', 'Orders.rollingTwoDayAmount': '500' },
        { 'Orders.createdAt.day': '2024-01-04T00:00:00.000', 'Orders.rollingTwoDayAmount': '300' },
        { 'Orders.createdAt.day': '2024-01-05T00:00:00.000', 'Orders.rollingTwoDayAmount': '400' },
      ]);
    });

    test('evaluates rolling windows without date ranges', async () => {
      await expect(loadRows(client, {
        measures: ['Orders.rollingTwoDayAmount'],
        timeDimensions: [{
          dimension: 'Orders.createdAt',
          granularity: 'day',
        }],
        order: { 'Orders.createdAt.day': 'asc' },
      })).resolves.toEqual([
        { 'Orders.createdAt.day': '2024-01-01T00:00:00.000', 'Orders.rollingTwoDayAmount': '100' },
        { 'Orders.createdAt.day': '2024-01-02T00:00:00.000', 'Orders.rollingTwoDayAmount': '300' },
        { 'Orders.createdAt.day': '2024-01-03T00:00:00.000', 'Orders.rollingTwoDayAmount': '500' },
        { 'Orders.createdAt.day': '2024-01-04T00:00:00.000', 'Orders.rollingTwoDayAmount': '300' },
        { 'Orders.createdAt.day': '2024-01-05T00:00:00.000', 'Orders.rollingTwoDayAmount': '400' },
        { 'Orders.createdAt.day': '2024-01-06T00:00:00.000', 'Orders.rollingTwoDayAmount': '400' },
        { 'Orders.createdAt.day': '2025-01-01T00:00:00.000', 'Orders.rollingTwoDayAmount': '500' },
        { 'Orders.createdAt.day': '2025-01-02T00:00:00.000', 'Orders.rollingTwoDayAmount': '1100' },
      ]);
    });

    test('evaluates period-to-date rolling windows grouped by time', async () => {
      await expect(loadRows(client, {
        measures: ['Orders.amountYtd'],
        timeDimensions: [{
          dimension: 'Orders.createdAt',
          granularity: 'day',
          dateRange: ['2025-01-01', '2025-01-02'],
        }],
        order: { 'Orders.createdAt.day': 'asc' },
      })).resolves.toEqual([
        { 'Orders.createdAt.day': '2025-01-01T00:00:00.000', 'Orders.amountYtd': '500' },
        { 'Orders.createdAt.day': '2025-01-02T00:00:00.000', 'Orders.amountYtd': '1100' },
      ]);
    });

    test('evaluates group_by, reduce_by, and add_group_by multi-stage measures', async () => {
      await expect(loadRows(client, {
        measures: ['Orders.totalAmount', 'Orders.amountByCategory'],
        dimensions: ['Orders.category', 'Orders.currency'],
        order: {
          'Orders.category': 'asc',
          'Orders.currency': 'asc',
        },
      })).resolves.toEqual([
        { 'Orders.category': 'hardware', 'Orders.currency': 'EUR', 'Orders.totalAmount': '200', 'Orders.amountByCategory': '800' },
        { 'Orders.category': 'hardware', 'Orders.currency': 'USD', 'Orders.totalAmount': '600', 'Orders.amountByCategory': '800' },
        { 'Orders.category': 'software', 'Orders.currency': 'EUR', 'Orders.totalAmount': '1000', 'Orders.amountByCategory': '1300' },
        { 'Orders.category': 'software', 'Orders.currency': 'USD', 'Orders.totalAmount': '300', 'Orders.amountByCategory': '1300' },
      ]);

      await expect(loadRows(client, {
        measures: ['Orders.totalAmount', 'Orders.amountWithoutCurrency'],
        dimensions: ['Orders.category', 'Orders.currency'],
        order: {
          'Orders.category': 'asc',
          'Orders.currency': 'asc',
        },
      })).resolves.toEqual([
        { 'Orders.category': 'hardware', 'Orders.currency': 'EUR', 'Orders.totalAmount': '200', 'Orders.amountWithoutCurrency': '800' },
        { 'Orders.category': 'hardware', 'Orders.currency': 'USD', 'Orders.totalAmount': '600', 'Orders.amountWithoutCurrency': '800' },
        { 'Orders.category': 'software', 'Orders.currency': 'EUR', 'Orders.totalAmount': '1000', 'Orders.amountWithoutCurrency': '1300' },
        { 'Orders.category': 'software', 'Orders.currency': 'USD', 'Orders.totalAmount': '300', 'Orders.amountWithoutCurrency': '1300' },
      ]);

      await expect(loadRows(client, {
        measures: ['Orders.avgCustomerAmount'],
        dimensions: ['Orders.category'],
        order: { 'Orders.category': 'asc' },
      })).resolves.toEqual([
        { 'Orders.category': 'hardware', 'Orders.avgCustomerAmount': '400' },
        { 'Orders.category': 'software', 'Orders.avgCustomerAmount': '650' },
      ]);
    });

    test('evaluates time shift measures with explicit and inferred time dimensions', async () => {
      await expect(loadRows(client, {
        measures: ['Orders.totalAmount', 'Orders.amountPriorYear', 'Orders.amountPriorYearInferred'],
        timeDimensions: [{
          dimension: 'Orders.createdAt',
          granularity: 'day',
          dateRange: ['2025-01-01', '2025-01-02'],
        }],
        order: { 'Orders.createdAt.day': 'asc' },
      })).resolves.toEqual([
        {
          'Orders.createdAt.day': '2025-01-01T00:00:00.000',
          'Orders.totalAmount': '500',
          'Orders.amountPriorYear': '100',
          'Orders.amountPriorYearInferred': '100',
        },
        {
          'Orders.createdAt.day': '2025-01-02T00:00:00.000',
          'Orders.totalAmount': '600',
          'Orders.amountPriorYear': '200',
          'Orders.amountPriorYearInferred': '200',
        },
      ]);
    });

    test('applies bound filters on time shift measures', async () => {
      await expect(loadRows(client, {
        measures: ['Orders.totalAmount', 'Orders.amountPriorYear'],
        timeDimensions: [{
          dimension: 'Orders.createdAt',
          granularity: 'day',
          dateRange: ['2025-01-01', '2025-01-02'],
        }],
        filters: [{
          member: 'Orders.currency',
          operator: 'equals',
          values: ['USD'],
        }],
        order: { 'Orders.createdAt.day': 'asc' },
      })).resolves.toEqual([
        {
          'Orders.createdAt.day': '2025-01-01T00:00:00.000',
          'Orders.totalAmount': '500',
          'Orders.amountPriorYear': '100',
        },
      ]);
    });

    test('evaluates switch dimensions and case measures', async () => {
      await expect(loadRows(client, {
        measures: ['MetricSwitch.amountInCurrency'],
        dimensions: ['MetricSwitch.currency'],
        order: { 'MetricSwitch.currency': 'asc' },
      })).resolves.toEqual([
        { 'MetricSwitch.currency': 'EUR', 'MetricSwitch.amountInCurrency': '540' },
        { 'MetricSwitch.currency': 'GBP', 'MetricSwitch.amountInCurrency': '480' },
        { 'MetricSwitch.currency': 'USD', 'MetricSwitch.amountInCurrency': '600' },
      ]);

      await expect(loadRows(client, {
        measures: ['MetricSwitch.amountInCurrency'],
        dimensions: ['MetricSwitch.currency', 'MetricSwitch.source'],
        filters: [{
          member: 'MetricSwitch.currency',
          operator: 'equals',
          values: ['EUR'],
        }],
        order: {
          'MetricSwitch.currency': 'asc',
          'MetricSwitch.source': 'asc',
        },
      })).resolves.toEqual([
        { 'MetricSwitch.currency': 'EUR', 'MetricSwitch.source': 'actual', 'MetricSwitch.amountInCurrency': '540' },
        { 'MetricSwitch.currency': 'EUR', 'MetricSwitch.source': 'forecast', 'MetricSwitch.amountInCurrency': '540' },
      ]);
    });
  });
}

runKingbaseTesseractSuite({
  type: 'kingbase-pg',
  port: '54322',
  envPrefix: 'KINGBASE_PG',
  schemaDir: 'kingbase-pg-tesseract/schema',
  cubejsConfig: 'kingbase-pg-tesseract/cube.js',
});

runKingbaseTesseractSuite({
  type: 'kingbase-oracle',
  port: '54321',
  envPrefix: 'KINGBASE_ORACLE',
  schemaDir: 'kingbase-oracle-tesseract/schema',
  cubejsConfig: 'kingbase-oracle-tesseract/cube.js',
});
