import { MssqlQuery } from '../../src/adapter/MssqlQuery';
import { PostgresQuery } from '../../src/adapter/PostgresQuery';
import { prepareJsCompiler } from './PrepareCompiler';

const schema = `cube('Snapshots', {
  sql: "SELECT * FROM snapshots WHERE note <> 'FROM windowed_data'",
  measures: {
    closing: { sql: 'amount', type: 'sum', nonAdditiveDimension: { name: 'at', windowChoice: 'max' } },
    opening: { sql: 'amount', type: 'sum', nonAdditiveDimension: { name: 'at', windowChoice: 'min' } },
    closingCount: { sql: 'quantity', type: 'sum', nonAdditiveDimension: { name: 'at', windowChoice: 'max' } },
    ratio: { sql: \`\${closing} / NULLIF(\${closingCount}, 0)\`, type: 'number' },
    total: { sql: 'amount', type: 'sum' }
  },
  dimensions: {
    id: { sql: 'id', type: 'number', primaryKey: true },
    at: { sql: 'stat_at', type: 'time' },
    category: { sql: 'category', type: 'string' }
  }
});
cube('Details', {
  sql: 'SELECT * FROM details',
  joins: {
    Snapshots: { sql: \`\${CUBE}.snapshot_id = \${Snapshots}.id\`, relationship: 'many_to_one' }
  },
  measures: { total: { sql: 'amount', type: 'sum' } },
  dimensions: { id: { sql: 'id', type: 'number', primaryKey: true } }
});`;

describe('MSSQL semi-additive query composition', () => {
  const compilers = prepareJsCompiler(schema, { adapter: 'mssql' });
  beforeAll(async () => compilers.compiler.compile());

  it.each([undefined, 'day', 'month', 'year'])(
    'keeps closing snapshots valid inside a derived query (%s)', (granularity) => {
      const query = new MssqlQuery(compilers, {
        timezone: 'UTC',
        measures: ['Snapshots.closing'],
        timeDimensions: granularity ? [{ dimension: 'Snapshots.at', granularity }] : [],
        rowLimit: 100,
        useNativeSqlPlanner: true,
      });
      const [sql] = query.buildSqlAndParams();
      expect(sql).not.toMatch(/\bWITH\s+base_data\b/i);
      expect(sql).toMatch(/TOP\s+\(100\)\s+/i);
      expect(sql).toContain('MAX(');
      expect(sql).toContain('OVER (');
      expect(sql).toContain('SUM(CASE WHEN');
      expect(sql).toContain("note <> 'FROM windowed_data'");
      expect(sql).toContain('AS base_data');
      expect(sql).toContain('AS windowed_data');
    }
  );

  it.each([['Snapshots.ratio'], ['Snapshots.opening', 'Snapshots.closing', 'Snapshots.ratio']])(
    'renders explicit and implicit snapshot dependencies: %s', (...measures) => {
      const [sql, params] = new MssqlQuery(compilers, {
        measures,
        dimensions: ['Snapshots.category'],
        filters: [{ member: 'Snapshots.category', operator: 'equals', values: ['A'] }],
        rowLimit: 10,
        useNativeSqlPlanner: true,
      }).buildSqlAndParams();
      expect(sql).not.toMatch(/\bWITH\s+base_data\b/i);
      expect(sql).toContain('NULLIF(');
      expect(sql).toContain('SUM(CASE WHEN');
      expect(params).toEqual(['A']);
    }
  );

  it('keeps zero limit and total wrappers syntactically separate from the select list', () => {
    const [sql] = new MssqlQuery(compilers, {
      measures: ['Snapshots.closing'], rowLimit: 0,
    }).buildSqlAndParams();
    expect(sql).toMatch(/TOP\s+\(0\)\s+/i);
    expect(sql).not.toMatch(/\bWITH\s+base_data\b/i);
  });

  it('leaves PostgreSQL snapshot CTE rendering unchanged', () => {
    const [sql] = new PostgresQuery(compilers, {
      measures: ['Snapshots.closing'], useNativeSqlPlanner: false,
    }).buildSqlAndParams();
    expect(sql).toContain('WITH base_data AS');
    expect(sql).not.toContain('TOP (');
  });

  describe('pagination without an explicit order', () => {
    it.each(['closing', 'ratio', 'total'])('orders both pages of %s by all grouping dimensions', (measure) => {
      for (const offset of [0, 5]) {
        const [sql] = new MssqlQuery(compilers, {
          timezone: 'UTC',
          measures: [`Snapshots.${measure}`],
          dimensions: ['Snapshots.category'],
          timeDimensions: [{ dimension: 'Snapshots.at', granularity: 'month' }],
          order: [],
          rowLimit: 5,
          offset,
          useNativeSqlPlanner: false,
        }).buildSqlAndParams();
        expect(sql).toContain(' ORDER BY "snapshots__category" ASC, "snapshots__at_month" ASC');
        if (offset) {
          expect(sql).toMatch(/ ASC OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY$/);
          expect(sql).not.toContain('TOP (');
        } else {
          expect(sql).toContain('TOP (5)');
        }
      }
    });

    it('qualifies grouping aliases when joining aggregate branches', () => {
      const [sql] = new MssqlQuery(compilers, {
        measures: ['Snapshots.total', 'Details.total'],
        dimensions: ['Snapshots.category'],
        order: [], rowLimit: 5, offset: 5, useNativeSqlPlanner: false,
      }).buildSqlAndParams();
      expect(sql).toContain('JOIN');
      expect(sql).toContain(' ORDER BY q_0."snapshots__category" ASC OFFSET 5 ROWS');
    });

    it('preserves an explicit descending order', () => {
      const [sql] = new MssqlQuery(compilers, {
        measures: ['Snapshots.closing'],
        dimensions: ['Snapshots.category'],
        order: [{ id: 'Snapshots.category', desc: true }], rowLimit: 5, offset: 5,
      }).buildSqlAndParams();
      expect(sql).toMatch(/ ORDER BY "snapshots__category" DESC OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY$/);
    });

    it.each([5, null])('supports an aggregate without dimensions and row limit %s', (rowLimit) => {
      const [sql] = new MssqlQuery(compilers, {
        measures: ['Snapshots.ratio'], order: [], rowLimit, offset: 5,
      }).buildSqlAndParams();
      expect(sql).toContain(' ORDER BY 1 ASC OFFSET 5 ROWS');
    });

    it('uses the same fallback with the default TOP limit', () => {
      const [sql] = new MssqlQuery(compilers, {
        measures: ['Snapshots.closing'], dimensions: ['Snapshots.category'], order: [],
      }).buildSqlAndParams();
      expect(sql).toContain('TOP (10000)');
      expect(sql).toMatch(/ ORDER BY "snapshots__category" ASC$/);
    });

    it.each([false, true])('does not add sorting to an unlimited query (total: %s)', async (totalQuery) => {
      const isolatedCompilers = prepareJsCompiler(schema, { adapter: 'mssql' });
      await isolatedCompilers.compiler.compile();
      const [sql] = new MssqlQuery(isolatedCompilers, {
        measures: ['Snapshots.closing'], dimensions: ['Snapshots.category'],
        order: [], rowLimit: null, totalQuery, useNativeSqlPlanner: false,
      }).buildSqlAndParams();
      expect(sql).not.toContain(' ORDER BY ');
      expect(sql).not.toContain('TOP (');
      if (totalQuery) {
        expect(sql).toMatch(/^select count\(\*\)/);
      }
    });

    it('leaves empty-order PostgreSQL pagination unchanged', () => {
      const [sql] = new PostgresQuery(compilers, {
        measures: ['Snapshots.closing'], dimensions: ['Snapshots.category'],
        order: [], rowLimit: 5, offset: 5, useNativeSqlPlanner: false,
      }).buildSqlAndParams();
      expect(sql).not.toContain(' ORDER BY ');
      expect(sql).toMatch(/ LIMIT 5 OFFSET 5$/);
    });
  });
});
