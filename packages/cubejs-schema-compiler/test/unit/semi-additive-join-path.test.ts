/* eslint-disable no-restricted-syntax */
import { MysqlQuery } from '../../src/adapter/MysqlQuery';
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { prepareJsCompiler } from './PrepareCompiler';

describe('semi-additive join path (partition_bounds)', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(`
    cube(\`loan_debt\`, {
      sql_table: \`loan_stand_book_detail_list\`,

      joins: {
        cust: {
          relationship: \`many_to_one\`,
          sql: \`\${CUBE.cust_no} = \${cust.cust_no}\`,
        },
      },

      dimensions: {
        id: {
          sql: \`\${CUBE}.id\`,
          type: 'number',
          primary_key: true,
        },
        cust_no: {
          sql: \`\${CUBE}.cust_no\`,
          type: 'string',
        },
        etl_date_date: {
          sql: \`\${CUBE}.etl_date_date\`,
          type: 'time',
        },
        loan_bal: {
          sql: \`\${CUBE}.loan_bal\`,
          type: 'number',
        },
      },

      measures: {
        dkye: {
          type: 'sum',
          sql: 'loan_bal',
          nonAdditiveDimension: {
            name: 'etl_date_date',
            windowChoice: 'max',
          },
        },
        avg_bal: {
          type: 'sum',
          sql: 'loan_bal',
          nonAdditiveDimension: {
            name: 'etl_date_date',
            windowChoice: 'avg',
          },
        },
      },
    }),

    cube(\`cust\`, {
      sql_table: \`customer_base_info\`,

      joins: {
        org: {
          relationship: \`many_to_one\`,
          sql: \`\${CUBE.org_no} = \${org.org_no}\`,
        },
      },

      dimensions: {
        cust_no: {
          sql: \`\${CUBE}.cust_no\`,
          type: 'string',
          primary_key: true,
        },
        org_no: {
          sql: \`\${CUBE}.org_no\`,
          type: 'string',
        },
      },
    }),

    cube(\`org\`, {
      sql_table: \`bank_org_dim\`,

      dimensions: {
        org_no: {
          sql: \`\${CUBE}.org_no\`,
          type: 'string',
          primary_key: true,
        },
        org_short_name: {
          sql: \`\${CUBE}.org_short_name\`,
          type: 'string',
        },
      },
    })
  `, { adapter: 'mysql' });

  beforeAll(async () => {
    await compiler.compile();
  });

  it('uses partition_bounds + matched_data for max windowChoice (MySQL)', () => {
    const query = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['loan_debt.dkye'],
        dimensions: ['org.org_short_name'],
        timeDimensions: [{
          dimension: 'loan_debt.etl_date_date',
          granularity: 'day',
        }],
        timezone: 'UTC',
        limit: 10000,
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/partition_bounds_0 AS/i);
    expect(sql).toMatch(/matched_data AS/i);
    expect(sql).toMatch(/MAX\(`_loan_debt__etl_date_date_for_ordering`\)/i);
    expect(sql).toMatch(/INNER JOIN partition_bounds_0/i);
    expect(sql).not.toMatch(/__sa_base_inner/i);
    expect(sql).not.toMatch(/OVER\s*\(/i);
    expect(sql).not.toMatch(/windowed_data AS/i);
    // Layer B: ordering 列为裸字段（展示用 day 列仍可 CONVERT_TZ）
    expect(sql).toMatch(/`main__loan_debt`\.etl_date_date as `_loan_debt__etl_date_date_for_ordering`/i);
  });

  it('produces valid SQL when time dimension has only dateRange (no granularity) and no dimensions', () => {
    // Regression: a non-additive measure queried with a time dimension that only
    // carries a dateRange (no granularity) and no group dimensions produced
    // `SELECT , <measure> ... GROUP BY ` because BaseTimeDimension.aliasName()
    // returns null when granularity is absent.
    const query = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['loan_debt.dkye'],
        timeDimensions: [{
          dimension: 'loan_debt.etl_date_date',
          dateRange: ['2026-05-02', '2026-07-31'],
        }],
        filters: [{
          member: 'org.org_short_name',
          operator: 'equals',
          values: ['北京分行'],
        }],
        timezone: 'UTC',
        limit: 10000,
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/partition_bounds_0 AS/i);
    expect(sql).toMatch(/matched_data AS/i);
    // No group dimension -> no GROUP BY clause, and SELECT must not start with a dangling comma.
    expect(sql).not.toMatch(/SELECT\s*,/i);
    expect(sql).not.toMatch(/GROUP BY\s*\)/i);
    expect(sql).not.toMatch(/GROUP BY\s*`?\)/i);
    // No group dimensions -> no GROUP BY in the final projection at all.
    expect(sql).not.toMatch(/GROUP BY/i);
    // Final projection is the semi-additive COALESCE(...) measure with its alias.
    expect(sql).toMatch(/COALESCE\(SUM\(CASE WHEN/i);
    expect(sql).toMatch(/as `loan_debt__dkye` FROM matched_data/i);
  });

  it('produces valid SQL when the time range is a pure filter (inDateRange) instead of a timeDimension', () => {
    // 对照：把时间范围从 timeDimensions.dateRange 改写成 filters.inDateRange 后，
    // this.timeDimensions 为空 → dimensionsForSelect() 不含无 granularity 的 timeDim，
    // 即便旧逻辑未过滤 null 也不会产生 `SELECT ,` / `GROUP BY `。
    // 该用例固定这种写法始终合法，避免后续改动让此路径回退。
    const query = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['loan_debt.dkye'],
        filters: [
          {
            member: 'loan_debt.etl_date_date',
            operator: 'inDateRange',
            values: ['2026-05-02', '2026-07-31'],
          },
          {
            member: 'org.org_short_name',
            operator: 'equals',
            values: ['北京分行'],
          },
        ],
        timezone: 'UTC',
        limit: 10000,
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/WITH base_data AS/i);
    expect(sql).toMatch(/partition_bounds_0 AS/i);
    expect(sql).toMatch(/matched_data AS/i);
    expect(sql).not.toMatch(/SELECT\s*,/i);
    expect(sql).not.toMatch(/GROUP BY/i);
    expect(sql).toMatch(/COALESCE\(SUM\(CASE WHEN/i);
    expect(sql).toMatch(/as `loan_debt__dkye` FROM matched_data/i);
  });

  it('falls back to windowed_data OVER for avg windowChoice', () => {
    const query = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      {
        measures: ['loan_debt.avg_bal'],
        timeDimensions: [{
          dimension: 'loan_debt.etl_date_date',
          granularity: 'day',
        }],
        timezone: 'UTC',
      },
    );

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/windowed_data AS/i);
    expect(sql).toMatch(/OVER\s*\(/i);
    expect(sql).not.toMatch(/partition_bounds_/i);
    expect(sql).not.toMatch(/matched_data AS/i);
  });

  it('uses join path on Postgres as well', () => {
    const { compiler: c2, joinGraph: j2, cubeEvaluator: e2 } = prepareJsCompiler(`
      cube(\`facts\`, {
        sql: \`SELECT * FROM xss.balances\`,
        dimensions: {
          ds: { sql: \`\${CUBE}.ds\`, type: 'time' },
          account_id: { sql: \`\${CUBE}.account_id\`, type: 'string' },
        },
        measures: {
          balance_end: {
            type: 'sum',
            sql: 'balance',
            nonAdditiveDimension: { name: 'ds', windowChoice: 'max' },
          },
        },
      })
    `);

    return c2.compile().then(() => {
      const query = new PostgresQuery(
        { joinGraph: j2, cubeEvaluator: e2, compiler: c2 },
        {
          measures: ['facts.balance_end'],
          dimensions: ['facts.account_id'],
          timeDimensions: [{ dimension: 'facts.ds', granularity: 'month' }],
          timezone: 'UTC',
        },
      );
      const [sql] = query.buildSqlAndParams();
      expect(sql).toMatch(/partition_bounds_/i);
      expect(sql).toMatch(/matched_data AS/i);
      expect(sql).not.toMatch(/__sa_base_inner/i);
      expect(sql).not.toMatch(/OVER\s*\(/i);
    });
  });
});
