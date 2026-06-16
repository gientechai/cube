# Kingbase MySQL Transport Prototype Notes

Question: can the **Kingbase MySQL Target** use Postgres-compatible **Driver Transport** while keeping MySQL **SQL Dialect** semantics?

Run command:

```sh
yarn prototype:kingbase-mysql-transport
```

This is throwaway verification code. Delete it or fold the result into the real `kingbase-mysql` implementation once the transport decision is settled.

Result from local KingbaseES MySQL mode on `127.0.0.1:54323`:

- `pg` wire protocol connected and accepted `$1` parameters.
- `mysql` wire protocol did not complete the MySQL driver handshake within the probe timeout.
- Raw MySQL `?` placeholders failed through the `pg` driver path.
- MySQL-style SQL using backtick identifiers, `DATE_FORMAT`, and `CAST(... AS DATETIME)` succeeded through `pg` after converting `?` placeholders to `$n`.
- The `pg-query-stream` path worked with normalized placeholders and returned field metadata.
- The inherited Postgres driver upload path worked: `CREATE TABLE`, `INSERT ... SELECT * FROM UNNEST($1::text[], $2::int8[])`, and readback all succeeded in KingbaseES MySQL mode.
- Mixed identifier quoting worked: the same table was readable through both double-quoted identifiers from driver paths and backtick identifiers from MySQL SQL Dialect paths.
- The inherited Postgres metadata shape worked: `information_schema.columns` and primary-key discovery returned expected table, column, type, schema, and key rows.
- The inherited MySQL generated time series template shape failed on bare `INTERVAL 1 DAY`; a Kingbase MySQL-specific recursive CTE shape using quoted intervals, explicit `CAST($n AS DATETIME)`, and explicit recursive-term casts succeeded.
- Driver-suite fixture date casts need a Kingbase MySQL-specific mapping: MySQL `STR_TO_DATE` was not available, Postgres `to_date` returned a timestamp-shaped value, and `CAST(... AS DATE)` returned the expected date.

Prototype answer: the likely implementation path is Postgres-compatible **Driver Transport** plus MySQL **SQL Dialect**, with Kingbase MySQL placeholder normalization at the execution boundary and a focused generated time series override in the Kingbase MySQL dialect.

Rejected paths:

- Raw MySQL driver transport for the verified local KingbaseES MySQL-mode setup.
- Sending raw MySQL `?` placeholders through the pg driver path.
- Naive placeholder replacement that rewrites quoted SQL text, quoted identifiers, backtick identifiers, line comments, or block comments.
- Global MySQL or Postgres driver and dialect changes for Kingbase-only behavior.
- MySQL `STR_TO_DATE` for driver-suite date fixtures.
- Inherited bare `INTERVAL 1 DAY` generated-series SQL.
