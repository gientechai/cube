import { MssqlQuery } from '../../src/adapter/MssqlQuery';
import { prepareJsCompiler } from './PrepareCompiler';

const schema = `cube('Labels', {
  sql: "SELECT * FROM (VALUES (1,N'Alpha南自'),(2,N'alpha河海'),(3,NULL)) src(id,label)",
  measures: { count: { type: 'count' } },
  dimensions: {
    id: { sql: 'id', type: 'number', primaryKey: true, public: true },
    label: { sql: 'label', type: 'string' }
  }
});`;

describe('MSSQL 2016 string filters', () => {
  const compilers = prepareJsCompiler(schema, { adapter: 'mssql' });
  beforeAll(async () => compilers.compiler.compile());

  describe.each([false, true])('planner native=%s', (native) => {
    it.each(['contains', 'notContains', 'startsWith', 'notStartsWith', 'endsWith', 'notEndsWith'])(
      `renders parameterized %s in the configured planner (native=${native})`, (operator) => {
        const query = new MssqlQuery(compilers, {
          dimensions: ['Labels.id', 'Labels.label'],
          filters: [{ member: 'Labels.label', operator, values: ['Alpha\'南自'] }],
          ungrouped: true,
          useNativeSqlPlanner: native,
        });
        const [sql, params] = query.buildSqlAndParams();
        expect(query.useNativeSqlPlanner).toBe(native);
        expect(sql).not.toMatch(/\bILIKE\b|\|\|/i);
        expect(sql).toMatch(/LOWER\(/i);
        expect(sql).toMatch(/\bLIKE\s+CONCAT\(/i);
        expect(sql).not.toContain('Alpha\'南自');
        expect(params).toContain('Alpha\'南自');
        if (operator.startsWith('not')) {
          expect(sql).toMatch(/NOT LIKE/i);
          expect(sql).toMatch(/IS NULL/i);
        }
      }
    );

    it(`keeps contains wildcard characters literal (native=${native})`, () => {
      const query = new MssqlQuery(compilers, {
        dimensions: ['Labels.id'],
        filters: [{ member: 'Labels.label', operator: 'contains', values: ['[a]_%'] }],
        ungrouped: true,
        useNativeSqlPlanner: native,
      });
      const [sql, params] = query.buildSqlAndParams();
      if (native) {
        expect(sql).toMatch(/REPLACE\(REPLACE\(REPLACE\(/i);
        expect(params).toEqual(['[a]_%']);
      } else {
        expect(params).toEqual(['[[]a][_][%]']);
      }
    });
  });
});
