/* eslint-disable no-restricted-syntax */
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { prepareYamlCompiler } from './PrepareCompiler';
import { createSchemaYaml } from './utils';

const {
  applyMeasureFilterOrRewrite,
} = require('../../../../../examples/recipes/measure-filter-or-rewrite/measureFilterOrQueryRewrite');

const MEASURES_WITH_FILTERS = [
  'orders.electronics_profit',
  'orders.electronics_cost',
  'orders.electronics_revenue',
  'orders.electronics_daily_profit',
  'orders.electronics_office_profit',
];

const schemaYaml = createSchemaYaml({
  cubes: [{
    name: 'orders',
    sql: 'select * from orders',
    dimensions: [
      { name: 'type', sql: 'type', type: 'string' },
    ],
    measures: [
      { name: 'profit', sql: 'profit_amount', type: 'sum' },
      {
        name: 'electronics_profit',
        sql: 'profit_amount',
        type: 'sum',
        filters: [{ sql: `{CUBE}.type = '电子产品'` }],
      },
      {
        name: 'electronics_cost',
        sql: 'cost_amount',
        type: 'sum',
        filters: [{ sql: `{CUBE}.type = '电子产品'` }],
      },
      {
        name: 'electronics_revenue',
        sql: 'revenue_amount',
        type: 'sum',
        filters: [{ sql: `{CUBE}.type = '电子产品'` }],
      },
      {
        name: 'electronics_daily_profit',
        sql: 'profit_amount',
        type: 'sum',
        filters: [{ sql: `{CUBE}.type IN ('电子产品', '日用品')` }],
      },
      {
        name: 'electronics_office_profit',
        sql: 'profit_amount',
        type: 'sum',
        filters: [{ sql: `{CUBE}.type IN ('电子产品', '办公用品')` }],
      },
    ],
  }],
});

describe('measureFilter OR queryRewrite', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareYamlCompiler(schemaYaml);

  const rewriteOptions = {
    measuresWithFilters: MEASURES_WITH_FILTERS,
    triggerDimensions: ['orders.type'],
  };

  async function sqlForQuery(query: Record<string, unknown>) {
    await compiler.compile();
    const rewritten = applyMeasureFilterOrRewrite(query, rewriteOptions);
    const pq = new PostgresQuery({ joinGraph, cubeEvaluator, compiler }, rewritten);
    const [sql] = pq.buildSqlAndParams();
    return { sql, rewritten };
  }

  it('injects OR measureFilter when slice measures + type dimension', async () => {
    const query = {
      measures: ['orders.electronics_profit', 'orders.electronics_daily_profit'],
      dimensions: ['orders.type'],
    };
    const { rewritten, sql } = await sqlForQuery(query);

    expect(rewritten.filters).toEqual([
      {
        or: [
          { member: 'orders.electronics_profit', operator: 'measureFilter' },
          { member: 'orders.electronics_daily_profit', operator: 'measureFilter' },
        ],
      },
    ]);
    expect(sql).toMatch(/OR/i);
    expect(sql).toMatch(/电子产品/);
    expect(sql).toMatch(/日用品/);
    expect(sql).not.toMatch(/GROUP BY[\s\S]*WHERE[\s\S]*家具/);
  });

  it('case3: electronics_daily + electronics_office OR includes three types in WHERE', async () => {
    const { sql } = await sqlForQuery({
      measures: ['orders.electronics_daily_profit', 'orders.electronics_office_profit'],
      dimensions: ['orders.type'],
    });

    expect(sql).toMatch(/日用品/);
    expect(sql).toMatch(/办公用品/);
    expect(sql).toMatch(/OR/i);
  });

  it('case1: three electronics measures share OR branches', async () => {
    const { rewritten } = await sqlForQuery({
      measures: [
        'orders.electronics_profit',
        'orders.electronics_cost',
        'orders.electronics_revenue',
      ],
      dimensions: ['orders.type'],
    });

    expect(rewritten.filters[0].or).toHaveLength(3);
  });

  it('does not inject when mixed with unscoped profit measure', async () => {
    const { rewritten } = await sqlForQuery({
      measures: ['orders.profit', 'orders.electronics_profit'],
      dimensions: ['orders.type'],
    });

    expect(rewritten.filters || []).toHaveLength(0);
  });

  it('does not inject without trigger dimension', async () => {
    const { rewritten } = await sqlForQuery({
      measures: ['orders.electronics_profit'],
      dimensions: [],
    });

    expect(rewritten.filters || []).toHaveLength(0);
  });

  it('does not double-inject on second pass', async () => {
    const query = {
      measures: ['orders.electronics_profit'],
      dimensions: ['orders.type'],
    };
    const once = applyMeasureFilterOrRewrite(query, rewriteOptions);
    const twice = applyMeasureFilterOrRewrite(once, rewriteOptions);
    expect(twice.filters).toHaveLength(1);
  });
});
