#!/usr/bin/env node

/*
 * PROTOTYPE - throwaway verification for issue 23.
 *
 * Question: can the Kingbase MySQL Target use Postgres-compatible Driver
 * Transport while keeping MySQL SQL Dialect semantics?
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const QueryStream = require('pg-query-stream');
const mysql = require('mysql');

function readLocalPassword() {
  if (process.env.KINGBASE_MYSQL_PASSWORD) {
    return process.env.KINGBASE_MYSQL_PASSWORD;
  }
  if (process.env.CUBEJS_DB_PASS) {
    return process.env.CUBEJS_DB_PASS;
  }

  const agentsPath = path.join(process.env.HOME || '', 'kingbase', 'Agents.md');
  if (!fs.existsSync(agentsPath)) {
    return undefined;
  }

  const text = fs.readFileSync(agentsPath, 'utf8');
  const mysqlRow = text.split(/\r?\n/).find((line) => line.includes('kingbase-mysql'));
  if (!mysqlRow) {
    return undefined;
  }

  return mysqlRow
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean)[6]
    .replace(/^`|`$/g, '');
}

const config = {
  host: process.env.KINGBASE_MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.KINGBASE_MYSQL_PORT || 54323),
  database: process.env.KINGBASE_MYSQL_DATABASE || 'kingbase',
  user: process.env.KINGBASE_MYSQL_USER || 'system',
  password: readLocalPassword(),
};

function normalizeQuestionParams(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function cleanError(error) {
  return String(error && (error.message || error))
    .replace(config.password || '__never__', '[REDACTED]');
}

async function runProbe(name, fn) {
  try {
    const state = await Promise.race([
      fn(),
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('probe timed out after 5000ms')), 5000);
      }),
    ]);
    console.log(`PASS ${name}`);
    console.log(JSON.stringify(state, null, 2));
    return { name, ok: true, state };
  } catch (error) {
    const state = {
      error: cleanError(error),
      code: error && error.code,
    };
    console.log(`FAIL ${name}`);
    console.log(JSON.stringify(state, null, 2));
    return { name, ok: false, state };
  }
}

async function withPg(fn) {
  const client = new Client({
    ...config,
    connectionTimeoutMillis: 3000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function mysqlQuery(sql, values) {
  const connection = mysql.createConnection({
    ...config,
    timezone: 'Z',
    dateStrings: true,
    connectTimeout: 3000,
  });

  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      connection.destroy();
      reject(new Error('mysql probe timed out after 3000ms'));
    }, 3000);
  });

  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        connection.connect((connectError) => {
          if (connectError) {
            reject(connectError);
            return;
          }

          connection.query({ sql, values, timeout: 3000 }, (queryError, rows, fields) => {
            if (queryError) {
              reject(queryError);
            } else {
              resolve({
                rows,
                fields: fields && fields.map((field) => ({
                  name: field.name,
                  type: field.type,
                })),
              });
            }
          });
        });
      }),
      timeout,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    connection.destroy();
  }
}

async function main() {
  if (!config.password) {
    throw new Error('Missing KINGBASE_MYSQL_PASSWORD or CUBEJS_DB_PASS');
  }

  console.log('Kingbase MySQL transport prototype');
  console.log(JSON.stringify({
    question: 'pg driver transport plus MySQL SQL dialect',
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: '[REDACTED]',
  }, null, 2));

  const mysqlDialectSql = [
    'SELECT ? AS `bound_value`, DATE_FORMAT(CAST(? AS DATETIME), \'%Y-%m-%d\') AS `day_key`',
    [42, '2024-01-02 03:04:05'],
  ];

  const results = [];

  results.push(await runProbe('pg wire protocol accepts pg driver', async () => withPg(async (client) => {
    await client.query("SET TIME ZONE 'UTC'");
    const result = await client.query('SELECT $1::int AS number', ['1']);
    return {
      rows: result.rows,
      fields: result.fields.map((field) => ({
        name: field.name,
        dataTypeID: field.dataTypeID,
      })),
    };
  })));

  results.push(await runProbe('mysql wire protocol accepts MySQL driver', async () => {
    const result = await mysqlQuery(mysqlDialectSql[0], mysqlDialectSql[1]);
    return {
      rows: result.rows,
      fields: result.fields,
    };
  }));

  results.push(await runProbe('raw MySQL question placeholders through pg driver', async () => withPg(async (client) => {
    const result = await client.query(mysqlDialectSql[0], mysqlDialectSql[1]);
    return {
      rows: result.rows,
      fields: result.fields.map((field) => ({
        name: field.name,
        dataTypeID: field.dataTypeID,
      })),
    };
  })));

  results.push(await runProbe('MySQL dialect SQL normalized to pg placeholders', async () => withPg(async (client) => {
    const normalizedSql = normalizeQuestionParams(mysqlDialectSql[0]);
    const result = await client.query(normalizedSql, mysqlDialectSql[1]);
    return {
      sql: normalizedSql,
      rows: result.rows,
      fields: result.fields.map((field) => ({
        name: field.name,
        dataTypeID: field.dataTypeID,
      })),
    };
  })));

  results.push(await runProbe('pg stream-compatible cursor path smoke query', async () => withPg(async (client) => {
    const stream = client.query(new QueryStream(
      'SELECT $1 AS `label` UNION ALL SELECT $2 AS `label`',
      ['first', 'second'],
      { highWaterMark: 10 }
    ));
    const rows = [];
    for await (const row of stream) {
      rows.push(row);
    }
    return {
      rows,
      fields: stream._result.fields.map((field) => ({
        name: field.name,
        dataTypeID: field.dataTypeID,
      })),
    };
  })));

  results.push(await runProbe('Postgres driver upload SQL works in MySQL mode', async () => withPg(async (client) => {
    const table = 'prototype_kingbase_mysql_upload';
    await client.query(`DROP TABLE IF EXISTS ${table}`);
    await client.query(`CREATE TABLE ${table} ("name" text, "amount" int8)`);
    await client.query(
      `INSERT INTO ${table} ("name", "amount")
       SELECT * FROM UNNEST ($1::text[], $2::int8[])`,
      [['one', 'two'], [1, 2]]
    );
    const result = await client.query(`SELECT \`name\`, \`amount\` FROM ${table} ORDER BY \`amount\``);
    await client.query(`DROP TABLE IF EXISTS ${table}`);
    return {
      rows: result.rows,
      fields: result.fields.map((field) => ({
        name: field.name,
        dataTypeID: field.dataTypeID,
      })),
    };
  })));

  results.push(await runProbe('mixed identifier quoting and information schema work', async () => withPg(async (client) => {
    const table = 'prototype_kingbase_mysql_metadata';
    await client.query(`DROP TABLE IF EXISTS ${table}`);
    await client.query(`CREATE TABLE ${table} ("name" text, "amount" int8, PRIMARY KEY ("name"))`);
    await client.query(
      `INSERT INTO ${table} ("name", "amount") SELECT * FROM UNNEST ($1::text[], $2::int8[])`,
      [['one'], [1]]
    );

    const doubleQuoted = await client.query(`SELECT "name", "amount" FROM ${table}`);
    const backtickQuoted = await client.query(`SELECT \`name\`, \`amount\` FROM ${table}`);
    const schema = await client.query('SELECT current_schema() AS schema_name');
    const schemaName = schema.rows[0].schema_name;
    const columns = await client.query(
      `SELECT columns.column_name as "column_name",
              columns.table_name as "table_name",
              columns.table_schema as "table_schema",
              columns.data_type  as "data_type",
              columns.numeric_precision as "numeric_precision",
              columns.numeric_scale as "numeric_scale"
       FROM information_schema.columns
       WHERE table_name = $1 AND table_schema = $2
       ORDER BY columns.ordinal_position`,
      [table, schemaName]
    );
    const primaryKeys = await client.query(
      `SELECT
         columns.table_schema as "table_schema",
         columns.table_name as "table_name",
         columns.column_name as "column_name"
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage AS ccu USING (constraint_schema, constraint_name)
       JOIN information_schema.columns AS columns ON columns.table_schema = tc.constraint_schema
         AND tc.table_name = columns.table_name AND ccu.column_name = columns.column_name
       WHERE constraint_type = 'PRIMARY KEY' AND columns.table_name = $1`,
      [table]
    );

    await client.query(`DROP TABLE IF EXISTS ${table}`);

    return {
      doubleQuoted: doubleQuoted.rows,
      backtickQuoted: backtickQuoted.rows,
      schemaName,
      columns: columns.rows,
      primaryKeys: primaryKeys.rows,
    };
  })));

  results.push(await runProbe('MySQL generated time series SQL works after placeholder normalization', async () => withPg(async (client) => {
    const result = await client.query(
      `WITH RECURSIVE date_series (date_from) AS (
         SELECT CAST($1 AS DATETIME) AS date_from
         UNION ALL
         SELECT CAST(DATE_ADD(date_from, INTERVAL '1 DAY') AS DATETIME)
         FROM date_series
         WHERE DATE_ADD(date_from, INTERVAL '1 DAY') <= CAST($2 AS DATETIME)
       )
       SELECT CAST(date_from AS DATETIME) AS date_from,
              CAST(DATE_SUB(DATE_ADD(date_from, INTERVAL '1 DAY'), INTERVAL '1000 MICROSECOND') AS DATETIME) AS date_to
       FROM date_series`,
      ['2024-01-01 00:00:00', '2024-01-03 00:00:00']
    );
    return {
      rows: result.rows,
      fields: result.fields.map((field) => ({
        name: field.name,
        dataTypeID: field.dataTypeID,
      })),
    };
  })));

  results.push(await runProbe('driver-suite date fixture cast has a Kingbase MySQL shape', async () => withPg(async (client) => {
    const mysqlDateCast = await client.query('SELECT STR_TO_DATE($1, \'%Y-%m-%d\') AS value', ['2024-01-02'])
      .then((result) => ({ ok: true, rows: result.rows }))
      .catch((error) => ({ ok: false, error: cleanError(error), code: error.code }));
    const postgresDateCast = await client.query('SELECT to_date($1, \'YYYY-MM-DD\') AS value', ['2024-01-02']);
    const kingbaseDateCast = await client.query('SELECT CAST($1 AS DATE) AS value', ['2024-01-02']);

    return {
      mysqlDateCast,
      postgresDateCast: {
        rows: postgresDateCast.rows,
        fields: postgresDateCast.fields.map((field) => ({
          name: field.name,
          dataTypeID: field.dataTypeID,
        })),
      },
      kingbaseDateCast: {
        rows: kingbaseDateCast.rows,
        fields: kingbaseDateCast.fields.map((field) => ({
          name: field.name,
          dataTypeID: field.dataTypeID,
        })),
      },
    };
  })));

  const answer = {
    pgTransportViable: results.find((result) => result.name === 'pg wire protocol accepts pg driver').ok,
    mysqlTransportViable: results.find((result) => result.name === 'mysql wire protocol accepts MySQL driver').ok,
    needsQuestionPlaceholderNormalization: !results.find((result) => result.name === 'raw MySQL question placeholders through pg driver').ok,
    mysqlDialectOverPgViableAfterNormalization: results.find((result) => result.name === 'MySQL dialect SQL normalized to pg placeholders').ok,
    postgresUploadPathViable: results.find((result) => result.name === 'Postgres driver upload SQL works in MySQL mode').ok,
    postgresMetadataPathViable: results.find((result) => result.name === 'mixed identifier quoting and information schema work').ok,
    mysqlGeneratedTimeSeriesViable: results.find((result) => result.name === 'MySQL generated time series SQL works after placeholder normalization').ok,
    needsKingbaseMysqlDateFixtureMapping: results.find((result) => result.name === 'driver-suite date fixture cast has a Kingbase MySQL shape').ok,
  };

  console.log('ANSWER');
  console.log(JSON.stringify(answer, null, 2));

  if (!answer.pgTransportViable || !answer.mysqlDialectOverPgViableAfterNormalization || !answer.postgresUploadPathViable || !answer.postgresMetadataPathViable) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(cleanError(error));
  process.exitCode = 1;
});
