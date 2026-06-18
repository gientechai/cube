import { KingbaseMysqlDriver, KingbaseMysqlQuery } from '../src';
import { isDownloadTableMemoryData } from '@cubejs-backend/base-driver';

const config = {
  host: process.env.KINGBASE_MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.KINGBASE_MYSQL_PORT || 54323),
  database: process.env.KINGBASE_MYSQL_DATABASE || 'kingbase',
  user: process.env.KINGBASE_MYSQL_USER || 'system',
  password: process.env.KINGBASE_MYSQL_PASSWORD || process.env.CUBEJS_DB_PASS,
  storeTimezone: 'UTC',
};

const describeIf = config.password ? describe : describe.skip;

describeIf('Kingbase MySQL Driver compatibility', () => {
  jest.setTimeout(60 * 1000);

  let driver: KingbaseMysqlDriver;

  beforeEach(() => {
    driver = new KingbaseMysqlDriver(config);
  });

  afterEach(async () => {
    await driver.release();
  });

  test('testConnection succeeds over Postgres-compatible transport', async () => {
    await expect(driver.testConnection()).resolves.toBeUndefined();
  });

  test('normalizes MySQL placeholders for MySQL SQL semantics', async () => {
    const rows = await driver.query<any>(
      'SELECT ? AS value, CAST(? AS DATETIME) AS ts_value',
      ['cube', '2026-06-16 01:02:03']
    );

    expect(rows[0].value).toEqual('cube');
    expect(rows[0].ts_value).toBeTruthy();
  });

  test('supports placeholder-heavy filters, IN lists, and nested queries', async () => {
    const rows = await driver.query<any>(
      'SELECT * FROM (SELECT ? AS status, ? AS amount) t WHERE status = ? AND amount IN (?, ?)',
      ['paid', 10, 'paid', 10, 20]
    );

    expect(rows).toEqual([{ status: 'paid', amount: '10' }]);
  });

  test('downloadQueryResults normalizes placeholders and reports column types', async () => {
    const result = await driver.downloadQueryResults(
      'SELECT ? AS value, ? AS amount',
      ['cube', 42],
      { highWaterMark: 10 }
    );

    expect(isDownloadTableMemoryData(result)).toEqual(true);
    if (!isDownloadTableMemoryData(result)) {
      throw new Error('Expected in-memory download query results');
    }
    expect(result.rows).toEqual([{ value: 'cube', amount: '42' }]);
    expect(result.types.map(({ name }) => name)).toEqual(['value', 'amount']);
  });

  test('uploads rows with inherited Postgres UNNEST SQL and reads them back', async () => {
    const table = 'kingbase_mysql_upload_test';
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

    const rows = await driver.query<any>(`SELECT name, amount FROM "${table}" ORDER BY amount`, []);
    expect(rows).toEqual([{ name: 'one', amount: '1' }, { name: 'two', amount: '2' }]);

    await driver.dropTable(table);
  });

  test('streams normalized placeholder queries with field type metadata', async () => {
    const result = await driver.stream(
      'SELECT ? AS value UNION ALL SELECT ? AS value',
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

  test('metadata queries return inherited Postgres driver information', async () => {
    const table = 'kingbase_mysql_metadata_test';
    await driver.dropTable(table).catch(() => undefined);
    await driver.query(
      `CREATE TABLE "${table}" ("id" int8 PRIMARY KEY, "name" text)`,
      []
    );

    const columns = await driver.tableColumnTypes(`public.${table}`);
    expect(columns).toEqual([
      { name: 'id', type: 'bigint' },
      { name: 'name', type: 'text' },
    ]);

    const tables = await driver.getTablesQuery('public');
    expect(tables.some((row) => row.table_name === table)).toEqual(true);

    await driver.dropTable(table);
  });

  test('dialect-level backtick identifiers work after placeholder normalization', async () => {
    const table = 'kingbase_mysql_identifier_test';
    await driver.dropTable(table).catch(() => undefined);
    await driver.query(`CREATE TABLE "${table}" ("value" text)`, []);
    await driver.query(`INSERT INTO "${table}" ("value") VALUES (?)`, ['ok']);

    const rows = await driver.query<any>(`SELECT \`value\` FROM \`${table}\` WHERE \`value\` = ?`, ['ok']);
    expect(rows).toEqual([{ value: 'ok' }]);

    await driver.dropTable(table);
  });

  test('executes Kingbase-compatible week and quarter time grouping expressions', async () => {
    const query = Object.create(KingbaseMysqlQuery.prototype) as KingbaseMysqlQuery;
    const dimension = "CAST('2024-04-01 12:34:56.789' AS DATETIME)";
    const rows = await driver.query<any>(
      `
        SELECT
          ${query.timeGroupedColumn('week', dimension)} AS week_bucket,
          ${query.timeGroupedColumn('quarter', dimension)} AS quarter_bucket
      `,
      []
    );

    expect(rows).toEqual([{
      week_bucket: '2024-04-01 00:00:00',
      quarter_bucket: '2024-04-01 00:00:00',
    }]);
  });

  test('propagates actionable database errors', async () => {
    await expect(driver.query('SELECT * FROM missing_kingbase_mysql_table', []))
      .rejects.toThrow(/missing_kingbase_mysql_table/i);
    await expect(driver.query('SELECT ? +', [1]))
      .rejects.toThrow();
  });
});
