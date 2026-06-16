cube(`Customers`, {
  sql: `
    select 1 as id, 'Ada' as name
    union all
    select 2 as id, 'Grace' as name
  `,

  dimensions: {
    id: {
      sql: `id`,
      type: `number`,
      primaryKey: true,
    },
    name: {
      sql: `name`,
      type: `string`,
    },
  },
});
