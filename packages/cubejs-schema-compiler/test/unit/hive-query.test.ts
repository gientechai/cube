import { HiveQuery } from '../../src/adapter/HiveQuery';
import { prepareYamlCompiler } from './PrepareCompiler';

describe('HiveQuery', () => {
  const compilers = prepareYamlCompiler(`
cubes:
  - name: test
    sql: "SELECT 'east' AS region, 1 AS id"
    dimensions:
      - name: id
        sql: id
        type: number
      - name: region
        sql: region
        type: string
`);

  beforeAll(async () => {
    await compilers.compiler.compile();
  });

  it('keeps the native planner enabled when requested', () => {
    const query = new HiveQuery(
      {
        joinGraph: compilers.joinGraph,
        cubeEvaluator: compilers.cubeEvaluator,
        compiler: compilers.compiler,
      },
      { dimensions: ['test.region'], timezone: 'UTC', useNativeSqlPlanner: true },
    );

    expect(query.useNativeSqlPlanner).toBe(true);
  });

  it('uses Hive backtick quoting for Tesseract templates', () => {
    const query = new HiveQuery(
      {
        joinGraph: compilers.joinGraph,
        cubeEvaluator: compilers.cubeEvaluator,
        compiler: compilers.compiler,
      },
      { dimensions: ['test.region'], timezone: 'UTC' },
    );

    const templates = query.sqlTemplates();
    expect(templates.quotes.identifiers).toBe('`');
    expect(templates.quotes.escape).toBe('\\`');
    expect(templates.statements.group_by_exprs).toContain("attribute='expr'");
    expect(templates.statements.group_by_exprs).not.toContain("attribute='index'");
    // Keep BaseQuery's ORDER BY index form; Hive accepts ORDER BY 1.
    expect(templates.expressions.order_by).toContain('index');
  });

  it('generates backtick-quoted identifiers in classic Hive SQL', () => {
    const query = new HiveQuery(
      {
        joinGraph: compilers.joinGraph,
        cubeEvaluator: compilers.cubeEvaluator,
        compiler: compilers.compiler,
      },
      { dimensions: ['test.region'], timezone: 'UTC' },
    );

    const [sql] = query.buildSqlAndParams();
    expect(sql).toContain('`test`.region');
    expect(sql).not.toContain('"test".region');
  });
});
