import { KingbasePgDriver } from '../src';

const config = {
  host: process.env.KINGBASE_PG_HOST || '127.0.0.1',
  port: Number(process.env.KINGBASE_PG_PORT || 54322),
  database: process.env.KINGBASE_PG_DATABASE || 'kingbase',
  user: process.env.KINGBASE_PG_USER || 'system',
  password: process.env.KINGBASE_PG_PASSWORD,
  storeTimezone: 'UTC',
};

const describeIf = config.password ? describe : describe.skip;

describeIf('Kingbase PG Driver compatibility', () => {
  jest.setTimeout(60 * 1000);

  let driver: KingbasePgDriver;

  beforeEach(() => {
    driver = new KingbasePgDriver(config);
  });

  afterEach(async () => {
    await driver.release();
  });

  test('testConnection succeeds', async () => {
    await expect(driver.testConnection()).resolves.toBeUndefined();
  });

  test('queries typed scalar values and nulls', async () => {
    const rows = await driver.query<any>(
      'SELECT $1::int AS int_value, $2::numeric AS decimal_value, $3::text AS text_value, $4::timestamp AS ts_value, $5::boolean AS bool_value, $6::text AS null_value',
      [42, '10.50', 'cube', '2026-06-16 01:02:03', true, null]
    );

    expect(rows[0]).toMatchObject({
      int_value: 42,
      decimal_value: '10.50',
      text_value: 'cube',
      bool_value: true,
      null_value: null,
    });
    expect(rows[0].ts_value).toContain('2026-06-16T01:02:03');
  });

  test('uploads rows with Postgres UNNEST SQL and reads them back', async () => {
    const table = 'kingbase_pg_upload_test';
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

  test('streams rows with field type metadata', async () => {
    const result = await driver.stream(
      'SELECT $1::text AS value UNION ALL SELECT $2::text AS value',
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
    await expect(driver.query('SELECT * FROM missing_kingbase_pg_table', []))
      .rejects.toThrow(/missing_kingbase_pg_table/i);
    await expect(driver.query('SELECT $1::int +', [1]))
      .rejects.toThrow();
  });
});
