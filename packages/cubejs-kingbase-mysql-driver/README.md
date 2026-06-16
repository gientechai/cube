# Cube.js Kingbase MySQL Driver

`@cubejs-backend/kingbase-mysql-driver` is the driver package for the **Kingbase MySQL Target** (`CUBEJS_DB_TYPE=kingbase-mysql`).

The verified architecture is:

- Postgres-compatible **Driver Transport** for connection, execution, streaming, uploads, and metadata.
- MySQL **SQL Dialect** semantics for generated Cube SQL.
- **Kingbase MySQL Placeholder Normalization** at the driver execution boundary, converting generated MySQL `?` placeholders to Postgres-compatible `$n` placeholders while skipping quoted strings, quoted identifiers, backtick identifiers, and comments.

## Configuration

Use the normal Cube database variables:

```sh
CUBEJS_DB_TYPE=kingbase-mysql
CUBEJS_DB_HOST=127.0.0.1
CUBEJS_DB_PORT=54323
CUBEJS_DB_NAME=kingbase
CUBEJS_DB_USER=system
CUBEJS_DB_PASS=<local secret>
```

Do not commit or paste local passwords. The local tests read the password from `CUBEJS_DB_PASS` or `KINGBASE_MYSQL_PASSWORD`.

## Local Verification

Compile and unit-test the driver:

```sh
yarn --cwd packages/cubejs-kingbase-mysql-driver tsc --pretty false
yarn --cwd packages/cubejs-kingbase-mysql-driver test
```

Run real-database driver-suite coverage when a local KingbaseES MySQL-mode database is available:

```sh
CUBEJS_DB_PASS=<local secret> yarn --cwd packages/cubejs-testing driver:kingbase-mysql:local
```

Run smoke and Tesseract coverage through the Cube server harness:

```sh
CUBEJS_DB_PASS=<local secret> yarn --cwd packages/cubejs-testing tsc --pretty false
CUBEJS_DB_PASS=<local secret> yarn --cwd packages/cubejs-testing jest dist/test/smoke-kingbase.test.js --runInBand
CUBEJS_DB_PASS=<local secret> yarn --cwd packages/cubejs-testing jest dist/test/tesseract-kingbase.test.js --runInBand
```

The tests distinguish compile/unit coverage from real-database coverage. Without a password, local real-database suites are skipped.

## Known Limitations

This target is not a generic MySQL alias and does not certify every KingbaseES MySQL compatibility feature.

Known target-specific behavior:

- Raw MySQL driver transport did not complete the local handshake; use this driver package instead.
- Raw `?` placeholders are not sent through the pg path; they are normalized at the Kingbase MySQL driver boundary.
- The inherited MySQL generated time series template used bare `INTERVAL 1 DAY`; Kingbase MySQL uses a target-specific recursive CTE with quoted interval expressions and explicit `CAST(... AS DATETIME)`.
- Driver-suite date fixtures use `CAST(... AS DATE)` because MySQL `STR_TO_DATE` was not available in the verified local setup.
