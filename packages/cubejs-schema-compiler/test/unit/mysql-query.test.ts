import { ClickHouseQuery } from '../../src/adapter/ClickHouseQuery';
import { MysqlQuery } from '../../src/adapter/MysqlQuery';
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { prepareYamlCompiler } from './PrepareCompiler';

const multiStageTimeShiftSchema = `
cubes:
  - name: loan_debt
    sql: "SELECT '2024-01-01' AS distr_date, 100 AS loan_bal"

    dimensions:
      - name: distr_date
        sql: distr_date
        type: time

    measures:
      - name: dkye
        type: sum
        sql: loan_bal
        rolling_window:
          trailing: unbounded
      - name: dkye4
        type: number
        sql: "{dkye} - {dkye_last_month}"
        multi_stage: true
      - name: dkye_last_month
        type: number
        sql: "{dkye}"
        multi_stage: true
        time_shift:
          - time_dimension: distr_date
            interval: 1 month
            type: prior
`;

describe('ORDER BY on multi-stage JOIN (ambiguous dimension alias)', () => {
  const compilers = prepareYamlCompiler(multiStageTimeShiftSchema);

  it('MysqlQuery qualifies alias in JOIN and keeps IS NULL null ordering', async () => {
    await compilers.compiler.compile();

    const query = new MysqlQuery(compilers, {
      measures: ['loan_debt.dkye4'],
      timeDimensions: [
        {
          dimension: 'loan_debt.distr_date',
          granularity: 'day',
          dateRange: ['2026-05-03', '2026-06-03'],
        },
      ],
      timezone: 'UTC',
      order: [{ id: 'loan_debt.distr_date' }],
    });

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(
      /FROM cte_0 AS q_0 LEFT JOIN cte_2 AS q_1[\s\S]*ORDER BY q_0\.`loan_debt__distr_date_day` IS NULL DESC, q_0\.`loan_debt__distr_date_day` ASC/
    );
    expect(sql).not.toMatch(/ORDER BY 1 IS NULL/);
  });

  it('PostgresQuery uses positional ORDER BY', async () => {
    await compilers.compiler.compile();

    const query = new PostgresQuery(compilers, {
      measures: ['loan_debt.dkye4'],
      timeDimensions: [
        {
          dimension: 'loan_debt.distr_date',
          granularity: 'day',
          dateRange: ['2026-05-03', '2026-06-03'],
        },
      ],
      timezone: 'UTC',
      order: [{ id: 'loan_debt.distr_date' }],
    });

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(/LEFT JOIN[\s\S]*ORDER BY 1 ASC NULLS FIRST/);
    expect(sql).not.toMatch(/ORDER BY "loan_debt__distr_date_day" ASC NULLS FIRST/);
  });

  it('ClickHouseQuery qualifies dimension ORDER BY with q_0', async () => {
    await compilers.compiler.compile();

    const query = new ClickHouseQuery(compilers, {
      measures: ['loan_debt.dkye4'],
      timeDimensions: [
        {
          dimension: 'loan_debt.distr_date',
          granularity: 'day',
          dateRange: ['2026-05-03', '2026-06-03'],
        },
      ],
      timezone: 'UTC',
      order: [{ id: 'loan_debt.distr_date' }],
    });

    const [sql] = query.buildSqlAndParams();

    expect(sql).toMatch(
      /FROM cte_0 AS q_0 LEFT JOIN cte_2 AS q_1[\s\S]*ORDER BY q_0\.`loan_debt__distr_date_day` ASC/
    );
  });

  it('MysqlQuery uses dimension expressions in GROUP BY for measure-filter queries', async () => {
    const { compiler, joinGraph, cubeEvaluator } = prepareYamlCompiler(`
cubes:
  - name: mymetrics_facts
    sql: "SELECT 'North' AS region, 100 AS amount UNION ALL SELECT 'South', 200 UNION ALL SELECT 'East', 75"
    dimensions:
      - name: region
        sql: region
        type: string
    measures:
      - name: filtered_ns_amount
        type: sum
        sql: amount
        filters:
          - sql: "{CUBE}.region IN ('North', 'South')"
`);

    await compiler.compile();

    const queryOptions = {
      measures: ['mymetrics_facts.filtered_ns_amount'],
      dimensions: ['mymetrics_facts.region'],
    };

    const tesseractQuery = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      { ...queryOptions, useNativeSqlPlanner: true }
    );
    const [tesseractSql] = tesseractQuery.buildSqlAndParams();
    expect(tesseractSql).not.toMatch(/GROUP BY\s+1\b/);
    expect(tesseractSql).toMatch(/GROUP BY\s+`mymetrics_facts`\.region\b/);
    expect(tesseractSql).not.toMatch(/ORDER BY\s+`mymetrics_facts__filtered_ns_amount`\s+IS NULL/);

    const jsQuery = new MysqlQuery(
      { joinGraph, cubeEvaluator, compiler },
      { ...queryOptions, useNativeSqlPlanner: false }
    );
    const [jsSql] = jsQuery.buildSqlAndParams();
    expect(jsSql).not.toMatch(/GROUP BY\s+1\b/);
    expect(jsSql).toMatch(/GROUP BY\s+`mymetrics_facts`\.region\b/);
    expect(jsSql).toMatch(
      /ORDER BY sum\(CASE WHEN \(`mymetrics_facts`\.region IN \('North', 'South'\)\) THEN `mymetrics_facts`\.amount END\) IS NULL ASC, sum\(CASE WHEN \(`mymetrics_facts`\.region IN \('North', 'South'\)\) THEN `mymetrics_facts`\.amount END\) DESC/
    );
  });
});
