const assert = require('node:assert/strict');
const { MSSqlDriver } = require('../dist/src/MSSqlDriver');

async function verifyDecimalDriver(config, Driver = MSSqlDriver) {
  let callbackCount = 0;
  const driver = new Driver({ ...config, beforeConnect() { callbackCount++; } });
  const query = `SELECT
    CAST('3.1716454461745428' AS decimal(38,16)) AS ratio,
    CAST('-99999999999999999999.999999999999999999' AS numeric(38,18)) AS negative_value,
    CAST('99999999999999999999999999999999999999' AS decimal(38,0)) AS large_value,
    CAST('0.00000000000000000000000000000000000001' AS decimal(38,38)) AS tiny_value,
    CAST('0.0000' AS decimal(18,4)) AS zero_value,
    CAST(NULL AS decimal(38,16)) AS null_value,
    CAST(17 AS int) AS integer_value,
    CAST('9223372036854775807' AS bigint) AS bigint_value,
    CAST(1.5 AS float) AS float_value,
    CAST(12.3456 AS money) AS money_value,
    CAST('2024-12-31T00:00:00' AS datetime2) AS time_value,
    REPLICATE(CAST(N'南' AS nvarchar(max)),5000) AS long_text`;
  function check(row) {
    assert.equal(row.ratio, '3.1716454461745428');
    assert.equal(row.negative_value, '-99999999999999999999.999999999999999999');
    assert.equal(row.large_value, '99999999999999999999999999999999999999');
    assert.equal(row.tiny_value, '0.00000000000000000000000000000000000001');
    assert.equal(row.zero_value, '0.0000');
    assert.equal(row.null_value, null);
    assert.equal(String(row.integer_value), '17');
    assert.equal(String(row.bigint_value), '9223372036854775807');
    assert.equal(String(row.float_value), '1.5');
    assert.equal(String(row.money_value), '12.3456');
    assert.equal(row.long_text, '南'.repeat(5000));
  }
  try {
    const rows = await driver.query(query, []);
    assert.equal(rows.length, 1); check(rows[0]);
    const stream = await driver.stream(query, [], { highWaterMark: 1 });
    const streamed = [];
    try { for await (const row of stream.rowStream) { check(row); streamed.push(row); } }
    finally { await stream.release(); }
    assert.equal(streamed.length, 1);
    assert.deepEqual(streamed, rows);
    assert.ok(callbackCount > 0);
    return { ordinary: true, streaming: true, callbackPreserved: true, columns: Object.keys(rows[0]).length, longTextLength: rows[0].long_text.length };
  } finally { await driver.release(); }
}
module.exports = { verifyDecimalDriver };
if (require.main === module) {
  verifyDecimalDriver(JSON.parse(process.env.MSSQL_TEST_CONFIG)).then(x => console.log(JSON.stringify(x))).catch(e => { console.error(e); process.exitCode = 1; });
}
