cube(`MetricSwitch`, {
  sql: `
    select 1 as id, 100 as amount_usd from dual
    union all
    select 2 as id, 200 as amount_usd from dual
    union all
    select 3 as id, 300 as amount_usd from dual
  `,

  measures: {
    amountUsd: {
      sql: `amount_usd`,
      type: `sum`,
    },
    amountEur: {
      sql: `${amountUsd} * 0.9`,
      type: `number`,
    },
    amountGbp: {
      sql: `${amountUsd} * 0.8`,
      type: `number`,
    },
    amountInCurrency: {
      type: `number`,
      multi_stage: true,
      case: {
        switch: `${currency}`,
        when: [
          { value: `EUR`, sql: `${amountEur}` },
          { value: `GBP`, sql: `${amountGbp}` },
        ],
        else: {
          sql: `${amountUsd}`,
        },
      },
    },
  },

  dimensions: {
    id: {
      sql: `id`,
      type: `number`,
      primaryKey: true,
    },
    currency: {
      type: `switch`,
      values: [`USD`, `EUR`, `GBP`],
    },
    source: {
      type: `switch`,
      values: [`actual`, `forecast`],
    },
  },
});
