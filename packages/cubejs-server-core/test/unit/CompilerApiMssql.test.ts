import { CompilerApi } from '../../src/core/CompilerApi';

describe('MSSQL expression source discovery', () => {
  const repository = {
    localPath: () => __dirname,
    dataSchemaFiles: async () => [{
      fileName: 'sales.js',
      content: ['SqlSales', 'PgSales', 'MySales'].map(name => `cube('${name}', {
        sql: 'SELECT id, amount FROM sales', data_source: '${name}',
        measures: { amount: { sql: 'amount', type: 'sum' } },
        dimensions: { id: { sql: 'id', type: 'number', primaryKey: true }, value: { sql: 'amount', type: 'number' } }
      });`).join('\n'),
    }],
  };
  const expression = (cubeName: string, cubeParams = [cubeName]) => ({
    cubeName,
    name: 'total',
    expressionName: 'total',
    // Match the evaluated SQL API expression contract, including its cube parameter name.
    // eslint-disable-next-line no-new-func
    expression: new Function(cubeName, `return \`SUM(\${${cubeName}.value})\``),
    definition: JSON.stringify({
      cubeName, alias: 'total', expr: { type: 'SqlFunction', cubeParams, sql: `SUM(\${${cubeName}.value})` },
    }),
  });
  let api: CompilerApi;
  beforeEach(() => {
    const dialects: Record<string, 'mssql' | 'mysql' | 'postgres'> = { SqlSales: 'mssql', MySales: 'mysql' };
    api = new CompilerApi(repository, async ({ dataSource }) => dialects[dataSource] || 'postgres', { externalDbType: 'cubestore' });
  });
  afterEach(() => api.dispose());

  it('generates an expression aggregate using MSSQL despite the PostgreSQL default', async () => {
    const result = await api.getSql({
      measures: [expression('SqlSales')],
      order: [],
      filters: [],
      timeDimensions: [],
      cacheMode: 'stale-if-slow',
      renewQuery: undefined,
    });
    expect(result.dataSource).toBe('SqlSales');
    expect(result.sql[0]).toMatch(/SUM\(.*amount/i);
    expect(result.sql[0]).toContain('"total"');
    const ordinary = await api.getSql({ measures: ['SqlSales.amount'], order: [] });
    expect(result.cacheKeyQueries).toEqual(ordinary.cacheKeyQueries);
  });

  it.each([
    ['PostgreSQL', () => ({ measures: [expression('PgSales')] })],
    ['MySQL', () => ({ measures: [expression('MySales')] })],
    ['mixed members', () => ({ measures: [expression('SqlSales'), 'PgSales.amount'] })],
    ['mixed expression dependencies', () => ({ measures: [expression('SqlSales', ['SqlSales', 'PgSales'])] })],
    ['unknown cube', () => ({ measures: [expression('Unknown')] })],
    ['unknown query structure', () => ({ measures: [expression('SqlSales')], from: 'unknown' })],
    ['complex filters', () => ({ measures: [expression('SqlSales')], filters: [{ member: 'PgSales.value', operator: 'equals', values: ['1'] }] })],
  ])('preserves the existing discovery path for %s', async (_name, createQuery) => {
    const create = jest.spyOn(api, 'createQueryByDataSource');
    await expect(api.getSqlGenerator((createQuery as Function)())).rejects.toThrow();
    expect(create.mock.calls[0][3]).toBe('postgres');
  });

  it('keeps ordinary MSSQL member discovery unchanged', async () => {
    const create = jest.spyOn(api, 'createQueryByDataSource');
    const result = await api.getSql({ measures: ['SqlSales.amount'], order: [] });
    expect(create.mock.calls[0][3]).toBe('postgres');
    expect(result.dataSource).toBe('SqlSales');
  });
});
