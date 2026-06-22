/* eslint-disable no-restricted-syntax */
import { MysqlQuery } from '../../src/adapter/MysqlQuery';
import { prepareJsCompiler } from './PrepareCompiler';

describe('credit loan_balance_me6 reproduction', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(`
    cube('credit', {
      sql_table: 'poc_bank',

      measures: {
        loan_balance_me: {
          type: 'sum',
          sql: 'loan_balance',
          nonAdditiveDimension: {
            name: 'data_date',
            windowChoice: 'max',
          },
        },

        loan_balance_me_lastMonth: {
          type: 'number',
          sql: \`\${CUBE.loan_balance_me}\`,
          multi_stage: true,
          time_shift: [
            {
              interval: '1 month',
              type: 'prior',
            },
          ],
        },

        loan_balance_me6: {
          type: 'number',
          sql: \`\${CUBE.loan_balance_me} - \${CUBE.loan_balance_me_lastMonth}\`,
          multi_stage: true,
        },
      },

      dimensions: {
        data_date: {
          sql: \`STR_TO_DATE(\${CUBE}.data_date, '%Y%m%d')\`,
          type: 'time',
        },
      },
    })
  `, { adapter: 'mysql' });

  const buildQuery = (timeDimensions: any[]) => new MysqlQuery(
    { joinGraph, cubeEvaluator, compiler },
    {
      measures: ['credit.loan_balance_me6'],
      timeDimensions,
      timezone: 'Asia/Shanghai',
      limit: 100,
    },
  );

  it('compiles with single dateRange', async () => {
    await compiler.compile();

    const query = buildQuery([{
      dimension: 'credit.data_date',
      granularity: 'month',
      dateRange: ['2026-06-01', '2026-06-30'],
    }]);

    expect(() => query.buildSqlAndParams()).not.toThrow();
    const [sql] = query.buildSqlAndParams();
    expect(sql).toMatch(/WITH/i);
  });

  it('compiles multi_stage without semi-additive base', async () => {
    const { compiler: c2, joinGraph: j2, cubeEvaluator: e2 } = prepareJsCompiler(`
    cube('credit', {
      sql_table: 'poc_bank',
      measures: {
        loan_balance_me: { type: 'sum', sql: 'loan_balance' },
        loan_balance_me_lastMonth: {
          type: 'number',
          sql: \`\${CUBE.loan_balance_me}\`,
          multi_stage: true,
          time_shift: [{ interval: '1 month', type: 'prior' }],
        },
        loan_balance_me6: {
          type: 'number',
          sql: \`\${CUBE.loan_balance_me} - \${CUBE.loan_balance_me_lastMonth}\`,
          multi_stage: true,
        },
      },
      dimensions: {
        data_date: { sql: \`STR_TO_DATE(\${CUBE}.data_date, '%Y%m%d')\`, type: 'time' },
      },
    })
  `, { adapter: 'mysql' });
    await c2.compile();
    const query = new MysqlQuery({ joinGraph: j2, cubeEvaluator: e2, compiler: c2 }, {
      measures: ['credit.loan_balance_me6'],
      timeDimensions: [{ dimension: 'credit.data_date', granularity: 'month', dateRange: ['2026-06-01', '2026-06-30'] }],
      timezone: 'Asia/Shanghai',
    });
    expect(() => query.buildSqlAndParams()).not.toThrow();
  });
});
