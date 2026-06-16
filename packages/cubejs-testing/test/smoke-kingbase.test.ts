import cubejs, { CubeApi } from '@cubejs-client/core';
// eslint-disable-next-line import/no-extraneous-dependencies
import { afterAll, beforeAll, describe, expect, jest } from '@jest/globals';
import { BirdBox, DriverType, getBirdbox } from '../src';
import {
  DEFAULT_API_TOKEN,
  DEFAULT_CONFIG,
  JEST_AFTER_ALL_DEFAULT_TIMEOUT,
  JEST_BEFORE_ALL_DEFAULT_TIMEOUT,
} from './smoke-tests';

type SmokeTarget = {
  type: DriverType;
  port: string;
  envPrefix: 'KINGBASE_PG' | 'KINGBASE_ORACLE' | 'KINGBASE_MYSQL';
  schemaDir: string;
  cubejsConfig: string;
  supportsPreAggregations: boolean;
};

function runKingbaseSmoke({
  type,
  port,
  envPrefix,
  schemaDir,
  cubejsConfig,
  supportsPreAggregations,
}: SmokeTarget) {
  const hasPassword = !!process.env.CUBEJS_DB_PASS;
  const describeIf = hasPassword ? describe : describe.skip;

  describeIf(`${type} smoke`, () => {
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
          CUBEJS_DB_PASS: process.env.CUBEJS_DB_PASS,
          CUBEJS_EXTERNAL_DEFAULT: 'false',
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

    test('queries measures, dimensions, filters, order, and limits', async () => {
      const result = await client.load({
        measures: ['Orders.totalAmount'],
        dimensions: ['Orders.status'],
        filters: [
          { member: 'Orders.status', operator: 'equals', values: ['paid'] },
          { member: 'Orders.amount', operator: 'gt', values: ['50'] },
        ],
        order: { 'Orders.status': 'asc' },
        limit: 10,
      });

      expect(result.rawData()).toEqual([
        { 'Orders.status': 'paid', 'Orders.totalAmount': '300' },
      ]);
    });

    test('queries time dimensions and joins', async () => {
      const result = await client.load({
        measures: ['Orders.count'],
        dimensions: ['Orders.customerName'],
        timeDimensions: [{
          dimension: 'Orders.createdAt',
          granularity: 'day',
        }],
        order: {
          'Orders.createdAt.day': 'asc',
          'Orders.customerName': 'asc',
        },
      });

      expect(result.rawData().map((row) => ({
        'Orders.createdAt.day': row['Orders.createdAt.day'],
        'Orders.customerName': row['Orders.customerName'],
        'Orders.count': row['Orders.count'],
      }))).toEqual([
        { 'Orders.createdAt.day': '2026-06-15T00:00:00.000', 'Orders.customerName': 'Ada', 'Orders.count': '1' },
        { 'Orders.createdAt.day': '2026-06-16T00:00:00.000', 'Orders.customerName': 'Ada', 'Orders.count': '1' },
        { 'Orders.createdAt.day': '2026-06-16T00:00:00.000', 'Orders.customerName': 'Grace', 'Orders.count': '1' },
      ]);
    });

    const preAggregationTest = supportsPreAggregations ? test : test.skip;

    preAggregationTest('builds and reads matching pre-aggregations', async () => {
      const result = await client.load({
        measures: ['Orders.totalAmount'],
        dimensions: ['Orders.status'],
        order: { 'Orders.status': 'asc' },
      });

      expect(result.rawData()).toEqual([
        { 'Orders.status': 'paid', 'Orders.totalAmount': '300' },
        { 'Orders.status': 'refunded', 'Orders.totalAmount': '300' },
      ]);
    });
  });
}

runKingbaseSmoke({
  type: 'kingbase-pg',
  port: '54322',
  envPrefix: 'KINGBASE_PG',
  schemaDir: 'kingbase-pg-smoke/schema',
  cubejsConfig: 'kingbase-pg-smoke/cube.js',
  supportsPreAggregations: true,
});

runKingbaseSmoke({
  type: 'kingbase-oracle',
  port: '54321',
  envPrefix: 'KINGBASE_ORACLE',
  schemaDir: 'kingbase-oracle-smoke/schema',
  cubejsConfig: 'kingbase-oracle-smoke/cube.js',
  supportsPreAggregations: false,
});

runKingbaseSmoke({
  type: 'kingbase-mysql',
  port: '54323',
  envPrefix: 'KINGBASE_MYSQL',
  schemaDir: 'kingbase-mysql-smoke/schema',
  cubejsConfig: 'kingbase-mysql-smoke/cube.js',
  supportsPreAggregations: true,
});
