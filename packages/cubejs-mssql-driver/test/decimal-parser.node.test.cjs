const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const { withExactMssqlDecimals } = require('../dist/src/MSSqlDriver');
const mr = createRequire(require.resolve('mssql'));
const tr = createRequire(mr.resolve('tedious'));
const parser = tr('./value-parser');
const original = parser.readValue;
const enabled = { useUTC: true };
let callbacks = 0;
const config = withExactMssqlDecimals({ server: 'test', beforeConnect(c) {
  assert.equal(c.config.options, enabled);
  callbacks++;
} });
config.beforeConnect({ config: { options: enabled } });
const metadata = (scale, type = 'DecimalN') => ({ type: { name: type }, precision: 38, scale });
function token(text, length, prefix = 0) {
  const buffer = Buffer.alloc(prefix + length + 1, 0);
  buffer[prefix] = length;
  buffer[prefix + 1] = text.startsWith('-') ? 0 : 1;
  let value = BigInt(text.replace(/[-.]/g, ''));
  for (let i = prefix + 2; i < buffer.length; i++) {
    buffer[i] = Number(value & BigInt(255)); value >>= BigInt(8);
  }
  assert.equal(value, BigInt(0));
  return buffer;
}
for (const [text, scale, length] of [
  ['0', 0, 5], ['-123.4500', 4, 9], ['0.00000001', 8, 5],
  ['3.1716454461745428', 16, 17], ['2.6780084227480038', 16, 17],
  ['99999999999999999999999999999999999999', 0, 17],
  ['-99999999999999999999.999999999999999999', 18, 17],
  ['0.00000000000000000000000000000000000001', 38, 17],
  ['12345678901234567890.123456789', 9, 13],
]) {
  for (const type of ['DecimalN', 'NumericN']) test(`${type} preserves ${text}`, () => {
    const buf = token(text, length, 3), meta = metadata(scale, type);
    const actual = parser.readValue(buf, 3, meta, enabled);
    assert.equal(actual.value, text);
    assert.equal(actual.offset, buf.length);
    const unmarked = { useUTC: true };
    assert.deepEqual(parser.readValue(buf, 3, meta, unmarked), original(buf, 3, meta, unmarked));
  });
}
test('NULL and all incomplete packet boundaries keep original behavior', () => {
  const meta = metadata(16), full = token('3.1716454461745428', 17, 2);
  const nullBuf = Buffer.from([0]);
  assert.deepEqual(parser.readValue(nullBuf, 0, meta, enabled), original(nullBuf, 0, meta, enabled));
  for (let end = 2; end < full.length; end++) {
    const partial = full.subarray(0, end);
    let expected;
    try { original(partial, 2, meta, enabled); } catch (e) { expected = e; }
    assert.ok(expected);
    assert.throws(() => parser.readValue(partial, 2, meta, enabled), e => e.constructor === expected.constructor && e.byteCount === expected.byteCount);
  }
});
test('other types retain values, types and offsets on enabled connections', () => {
  const samples = [
    [Buffer.from([123, 0, 0, 0]), { name: 'Int' }],
    [Buffer.from([255, 255, 255, 255, 255, 255, 255, 127]), { name: 'BigInt' }],
    [Buffer.from([8, 0, 0, 0, 0, 0, 0, 248, 63]), { name: 'FloatN' }],
    [Buffer.from([8, 0, 0, 0, 0, 123, 0, 0, 0]), { name: 'MoneyN' }],
    [Buffer.from([8, 0, 0, 0, 0, 0, 0, 0, 0]), { name: 'DateTimeN' }],
    [Buffer.from([4, 0, 65, 0, 66, 0]), { name: 'NVarChar' }],
  ];
  for (const [buf, type] of samples) {
    const meta = { type };
    assert.deepEqual(parser.readValue(buf, 0, meta, enabled), original(buf, 0, meta, enabled));
  }
});
test('multiple connections and callbacks remain independent', () => {
  assert.equal(callbacks, 1);
  assert.equal(config.server, 'test');
  const second = { useUTC: true };
  withExactMssqlDecimals({ server: 'second' }).beforeConnect({ config: { options: second } });
  const buf = token('3.1716454461745428', 17), meta = metadata(16);
  assert.equal(parser.readValue(buf, 0, meta, second).value, '3.1716454461745428');
  assert.equal(parser.readValue(buf, 0, meta, enabled).value, '3.1716454461745428');
  assert.equal(typeof parser.readValue(buf, 0, meta, {}).value, 'number');
});
