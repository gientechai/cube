cube(`Orders`, {
  sql: `
    select 1 as id, 1 as customer_id, 100 as amount, 'web' as source, 'USD' as currency, 'hardware' as category, TO_TIMESTAMP_TZ('2024-01-01T00:00:00.000Z', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"') as created_at from dual
    union all
    select 2 as id, 1 as customer_id, 200 as amount, 'web' as source, 'EUR' as currency, 'hardware' as category, TO_TIMESTAMP_TZ('2024-01-02T00:00:00.000Z', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"') as created_at from dual
    union all
    select 3 as id, 2 as customer_id, 300 as amount, 'store' as source, 'USD' as currency, 'software' as category, TO_TIMESTAMP_TZ('2024-01-03T00:00:00.000Z', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"') as created_at from dual
    union all
    select 4 as id, 2 as customer_id, 400 as amount, 'store' as source, 'EUR' as currency, 'software' as category, TO_TIMESTAMP_TZ('2024-01-05T00:00:00.000Z', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"') as created_at from dual
    union all
    select 5 as id, 3 as customer_id, 500 as amount, 'partner' as source, 'USD' as currency, 'hardware' as category, TO_TIMESTAMP_TZ('2025-01-01T00:00:00.000Z', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"') as created_at from dual
    union all
    select 6 as id, 3 as customer_id, 600 as amount, 'partner' as source, 'EUR' as currency, 'software' as category, TO_TIMESTAMP_TZ('2025-01-02T00:00:00.000Z', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"') as created_at from dual
  `,

  measures: {
    count: {
      type: `count`,
    },
    totalAmount: {
      sql: `amount`,
      type: `sum`,
    },
    rollingTwoDayAmount: {
      sql: `amount`,
      type: `sum`,
      rollingWindow: {
        trailing: `2 day`,
      },
    },
    amountYtd: {
      sql: `amount`,
      type: `sum`,
      rollingWindow: {
        type: `to_date`,
        granularity: `year`,
      },
    },
    amountPriorYear: {
      sql: `${totalAmount}`,
      type: `number`,
      multi_stage: true,
      time_shift: [{
        time_dimension: `${createdAt}`,
        interval: `1 year`,
        type: `prior`,
      }],
    },
    amountPriorYearInferred: {
      sql: `${totalAmount}`,
      type: `number`,
      multi_stage: true,
      time_shift: [{
        interval: `1 year`,
        type: `prior`,
      }],
    },
    amountByCategory: {
      sql: `${totalAmount}`,
      type: `sum`,
      multi_stage: true,
      group_by: [category],
    },
    amountWithoutCurrency: {
      sql: `${totalAmount}`,
      type: `sum`,
      multi_stage: true,
      reduce_by: [currency],
    },
    avgCustomerAmount: {
      sql: `${totalAmount}`,
      type: `avg`,
      multi_stage: true,
      add_group_by: [customerId],
    },
  },

  dimensions: {
    id: {
      sql: `id`,
      type: `number`,
      primaryKey: true,
    },
    customerId: {
      sql: `customer_id`,
      type: `number`,
    },
    source: {
      sql: `source`,
      type: `string`,
    },
    currency: {
      sql: `currency`,
      type: `string`,
    },
    category: {
      sql: `category`,
      type: `string`,
    },
    createdAt: {
      sql: `created_at`,
      type: `time`,
    },
  },
});
