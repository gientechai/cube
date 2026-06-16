cube(`Orders`, {
  sql: `
    select 1 as id, 1 as customer_id, 100 as amount, 'paid' as status, '2026-06-15'::timestamp as created_at
    union all
    select 2 as id, 1 as customer_id, 200 as amount, 'paid' as status, '2026-06-16'::timestamp as created_at
    union all
    select 3 as id, 2 as customer_id, 300 as amount, 'refunded' as status, '2026-06-16'::timestamp as created_at
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
