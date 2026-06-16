cube(`Orders`, {
  sql: `
    select 1 as id, 1 as customer_id, 100 as amount, 'paid' as status, TO_TIMESTAMP_TZ('2026-06-15T00:00:00.000Z', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"') as created_at from dual
    union all
    select 2 as id, 1 as customer_id, 200 as amount, 'paid' as status, TO_TIMESTAMP_TZ('2026-06-16T00:00:00.000Z', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"') as created_at from dual
    union all
    select 3 as id, 2 as customer_id, 300 as amount, 'refunded' as status, TO_TIMESTAMP_TZ('2026-06-16T00:00:00.000Z', 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"') as created_at from dual
  `,

  joins: {
    Customers: {
      relationship: `belongsTo`,
      sql: `${CUBE}.customer_id = ${Customers}.id`,
    },
  },

  preAggregations: {
    byStatus: {
      measures: [CUBE.count, CUBE.totalAmount],
      dimensions: [CUBE.status],
      refreshKey: {
        every: `1 hour`,
      },
    },
  },

  measures: {
    count: {
      type: `count`,
    },
    totalAmount: {
      sql: `amount`,
      type: `sum`,
    },
  },

  dimensions: {
    id: {
      sql: `id`,
      type: `number`,
      primaryKey: true,
    },
    customerName: {
      sql: `${Customers.name}`,
      type: `string`,
    },
    status: {
      sql: `status`,
      type: `string`,
    },
    amount: {
      sql: `amount`,
      type: `number`,
    },
    createdAt: {
      sql: `created_at`,
      type: `time`,
    },
  },
});
