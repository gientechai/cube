cube(`Customers`, {
  sql: `
    select 1 as id, 'Ada' as name from dual
    union all
    select 2 as id, 'Grace' as name from dual
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
