import { KingbaseOracleDriver } from '../src';

const config = {
  host: process.env.KINGBASE_ORACLE_HOST || '127.0.0.1',
  port: Number(process.env.KINGBASE_ORACLE_PORT || 54321),
  database: process.env.KINGBASE_ORACLE_DATABASE || 'kingbase',
  user: process.env.KINGBASE_ORACLE_USER || 'system',
  password: process.env.KINGBASE_ORACLE_PASSWORD,
  storeTimezone: 'UTC',
};

const describeIf = config.password ? describe : describe.skip;

describeIf('Kingbase Oracle Driver compatibility', () => {
  jest.setTimeout(60 * 1000);

  let driver: KingbaseOracleDriver;

  beforeEach(() => {
    driver = new KingbaseOracleDriver(config);
  });

  afterEach(async () => {
    await driver.release();
  });

  test('testConnection succeeds', async () => {
    await expect(driver.testConnection()).resolves.toBeUndefined();
  });

  test('normalizes Oracle placeholders for Oracle SQL semantics', async () => {
    const rows = await driver.query<any>(
      'SELECT :"?" AS value, TO_TIMESTAMP_TZ(:"?", \'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"\') AS ts_value FROM dual FETCH NEXT 1 ROWS ONLY',
      ['cube', '2026-06-16T01:02:03.000Z']
    );

    expect(rows[0].value).toEqual('cube');
    expect(rows[0].ts_value).toBeTruthy();
  });

  test('supports placeholder-heavy filters, IN lists, and nested queries', async () => {
    const rows = await driver.query<any>(
      'SELECT * FROM (SELECT :"?" AS status, :"?" AS amount FROM dual) t WHERE status = :"status" AND amount IN (:"?", :"?")',
      ['paid', 10, 'paid', 10, 20]
    );

    expect(rows).toEqual([{ status: 'paid', amount: '10' }]);
  });

  test('uploads rows with Postgres UNNEST SQL and reads them back', async () => {
    const table = 'kingbase_oracle_upload_test';
    await driver.dropTable(table).catch(() => undefined);
    await driver.uploadTableWithIndexes(
      table,
      [{ name: 'name', type: 'string' }, { name: 'amount', type: 'int' }],
      {
        rows: [{ name: 'one', amount: 1 }, { name: 'two', amount: 2 }],
        types: [{ name: 'name', type: 'string' }, { name: 'amount', type: 'int' }],
      },
      []
    );

    const rows = await driver.query<any>(`SELECT name, amount FROM ${table} ORDER BY amount`, []);
    expect(rows).toEqual([{ name: 'one', amount: '1' }, { name: 'two', amount: '2' }]);

    await driver.dropTable(table);
  });

  test('streams normalized placeholder queries with field type metadata', async () => {
    const result = await driver.stream(
      'SELECT :"?" AS value FROM dual UNION ALL SELECT :"?" AS value FROM dual',
      ['a', 'b'],
      { highWaterMark: 10 }
    );

    const rows: any[] = [];
    for await (const row of result.rowStream) {
      rows.push(row);
    }
    expect(result.release).toBeDefined();
    await result.release?.();

    expect(rows).toEqual([{ value: 'a' }, { value: 'b' }]);
    expect(result.types).toEqual([{ name: 'value', type: 'text' }]);
  });

  test('propagates actionable database errors', async () => {
    await expect(driver.query('SELECT * FROM missing_kingbase_oracle_table', []))
      .rejects.toThrow(/missing_kingbase_oracle_table/i);
    await expect(driver.query('SELECT :"?" + FROM dual', [1]))
      .rejects.toThrow();
  });
});
