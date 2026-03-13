/**
 * Unit tests for multi-stage renderWithQuery logic (BaseQuery.js).
 *
 * Verifies that when a CTE stage has no measures from the previous stage (only dimensions),
 * we query from the base table and use actual column refs in filters — avoiding
 * "missing FROM clause item" and "field does not exist" errors.
 *
 * Also ensures the normal case (stage that reads measures from previous CTE) still works.
 */

import { PostgresQuery } from '../../src';
import { prepareYamlCompiler } from './PrepareCompiler';

describe('Multi-stage renderWithQuery', () => {
  describe('base measure with filters + time_shift (stage FROM base table)', () => {
    const compilers = prepareYamlCompiler(`
cubes:
  - name: score
    sql: "SELECT 1 AS score_id, 85 AS score, '计算机' AS subject, '2024-01-10'::timestamp AS exam_date
         UNION ALL SELECT 2, 90, '数学', '2024-01-10'
         UNION ALL SELECT 3, 78, '计算机', '2023-01-10'"

    dimensions:
      - name: subject
        sql: subject
        type: string
      - name: exam_date
        sql: exam_date
        type: time
      - name: score
        sql: score
        type: number

    measures:
      - name: yzzbgl
        type: sum
        sql: score
        filters:
          - sql: "{CUBE}.subject = '计算机'"
      - name: yzzbgl_last_year
        type: number
        sql: "{yzzbgl}"
        multi_stage: true
        time_shift:
          - time_dimension: exam_date
            interval: 1 year
            type: prior
`);

    it('generates valid SQL: middle CTE FROM base table and uses actual column in measure filter', async () => {
      await compilers.compiler.compile();

      const query = new PostgresQuery(compilers, {
        measures: ['score.yzzbgl_last_year'],
        dimensions: ['score.subject'],
        timeDimensions: [],
        filters: [],
      });
      const [sql] = query.buildSqlAndParams();

      // Should use WITH (multi-stage)
      expect(sql).toMatch(/^\s*WITH\s+/i);
      // Base table must appear (some CTE or main query FROM base table)
      expect(sql).toContain('AS "score"');

      // The stage that computes yzzbgl (with filter on subject) must use actual column "score".subject
      // in its filter when that stage FROM base table, not the alias score__subject (which would
      // cause "field does not exist"). So the SQL must contain the filter with table-qualified column.
      expect(sql).toMatch(/"score"\.subject\s*=\s*'计算机'/);
    });

    it('generates valid SQL when time dimension is in query', async () => {
      await compilers.compiler.compile();

      const query = new PostgresQuery(compilers, {
        measures: ['score.yzzbgl_last_year'],
        dimensions: ['score.subject'],
        timeDimensions: [{
          dimension: 'score.exam_date',
          granularity: 'day',
          dateRange: ['2024-01-01', '2024-12-31'],
        }],
        timezone: 'UTC',
        filters: [],
      });
      const [sql] = query.buildSqlAndParams();

      expect(sql).toMatch(/^\s*WITH\s+/i);
      expect(sql).toContain('AS "score"');
      expect(sql).toMatch(/"score"\.subject\s*=\s*'计算机'/);
    });
  });

  describe('normal multi-stage: stage that reads from previous CTE', () => {
    const compilers = prepareYamlCompiler(`
cubes:
  - name: orders
    sql: "SELECT 1 AS id, 100 AS revenue, '2024-01-15'::timestamp AS created_at
         UNION ALL SELECT 2, 200, '2024-01-16'
         UNION ALL SELECT 3, 150, '2023-01-15'"

    dimensions:
      - name: date
        sql: created_at
        type: time

    measures:
      - name: revenue
        type: sum
        sql: revenue
      - name: revenue_1_y_ago
        type: number
        sql: "{revenue}"
        multi_stage: true
        time_shift:
          - time_dimension: date
            interval: 1 year
            type: prior
`);

    it('last CTE (time_shift) selects from previous CTE', async () => {
      await compilers.compiler.compile();

      const query = new PostgresQuery(compilers, {
        measures: ['orders.revenue', 'orders.revenue_1_y_ago'],
        timeDimensions: [{
          dimension: 'orders.date',
          granularity: 'day',
          dateRange: ['2024-01-01', '2024-12-31'],
        }],
        timezone: 'UTC',
        filters: [],
      });
      const [sql] = query.buildSqlAndParams();

      expect(sql).toMatch(/^\s*WITH\s+/i);
      // Time-shift stage should read from the previous CTE (e.g. cte_1 FROM cte_0 or JOIN cte_1)
      expect(sql).toMatch(/cte_1|FROM\s+cte_0/);
      expect(sql).toMatch(/orders__revenue/);
      expect(sql).toMatch(/orders__revenue_1_y_ago/);
    });
  });

  describe('no regression: simple multi-stage without time_shift', () => {
    const compilers = prepareYamlCompiler(`
cubes:
  - name: events
    sql: "SELECT 1 AS id, 10 AS value, '2024-01-01'::timestamp AS dt
         UNION ALL SELECT 2, 20, '2024-01-02'"

    dimensions:
      - name: dt
        sql: dt
        type: time

    measures:
      - name: total
        type: sum
        sql: value
      - name: total_dup
        type: number
        sql: "{total}"
        multi_stage: true
`);

    it('generates valid SQL for multi_stage measure referencing another measure', async () => {
      await compilers.compiler.compile();

      const query = new PostgresQuery(compilers, {
        measures: ['events.total_dup'],
        timeDimensions: [{
          dimension: 'events.dt',
          granularity: 'day',
          dateRange: ['2024-01-01', '2024-01-31'],
        }],
        timezone: 'UTC',
        filters: [],
      });
      const [sql] = query.buildSqlAndParams();

      expect(sql).toMatch(/^\s*WITH\s+/i);
      expect(sql).toContain('events__total');
    });
  });
});
