# Kingbase Local Verification

This document records how to verify the **Kingbase PG Target** and **Kingbase Oracle Target** against the local KingbaseES V009R001C010 containers.

## Target Semantics

- The **Kingbase PG Target** is `kingbase-pg`. It is a first-class Cube database type, uses Postgres-compatible **Driver Transport**, and uses Postgres **SQL Dialect** semantics.
- The **Kingbase Oracle Target** is `kingbase-oracle`. It is a first-class Cube database type, uses Postgres-compatible **Driver Transport**, and uses Oracle **SQL Dialect** semantics.
- **Kingbase Oracle Placeholder Normalization** runs only at the Kingbase Oracle execution boundary. It converts generated Oracle placeholders such as `:"?"` and repeated named binds to `$n` placeholders accepted by the Postgres-compatible transport.
- `pg-query-stream` is reused through the existing Postgres driver stream path. It is not a Kingbase-only dependency.

## Local Environment

The local containers are expected to be available on the host:

- Kingbase Oracle compatibility mode: `127.0.0.1:54321`
- Kingbase PG compatibility mode: `127.0.0.1:54322`
- Database: `kingbase`
- User: `system`
- Password: read it from the local-only `~/kingbase/Agents.md`

Do not commit or paste the password into docs, tests, snapshots, command output, or issue comments.

## Required Environment Variables

Use the normal Cube database environment variables:

```sh
export CUBEJS_DB_HOST=127.0.0.1
export CUBEJS_DB_NAME=kingbase
export CUBEJS_DB_USER=system
export CUBEJS_DB_PASS="$(...read from ~/kingbase/Agents.md locally...)"
```

For low-level driver package tests, the package tests use target-specific variables so both modes can be configured side by side:

```sh
export KINGBASE_PG_HOST=127.0.0.1
export KINGBASE_PG_PORT=54322
export KINGBASE_PG_DATABASE=kingbase
export KINGBASE_PG_USER=system
export KINGBASE_PG_PASSWORD="$CUBEJS_DB_PASS"

export KINGBASE_ORACLE_HOST=127.0.0.1
export KINGBASE_ORACLE_PORT=54321
export KINGBASE_ORACLE_DATABASE=kingbase
export KINGBASE_ORACLE_USER=system
export KINGBASE_ORACLE_PASSWORD="$CUBEJS_DB_PASS"
```

## Verification Commands

Build TypeScript first:

```sh
yarn tsc
```

Run low-level driver checks:

```sh
yarn workspace @cubejs-backend/kingbase-pg-driver test
yarn workspace @cubejs-backend/kingbase-oracle-driver test
```

Run driver-suite coverage against the existing local containers. Use `--mode=local`; in docker mode, `127.0.0.1` inside the Cube container is not the host.

```sh
yarn workspace @cubejs-backend/testing driver:kingbase-pg:local
yarn workspace @cubejs-backend/testing driver:kingbase-oracle:local
```

Run server smoke coverage:

```sh
yarn workspace @cubejs-backend/testing smoke:kingbase:local
```

Run Tesseract real-database coverage:

```sh
yarn workspace @cubejs-backend/testing tesseract:kingbase:local
```

## What The Tests Cover

- Low-level `testConnection`, typed scalar queries, nulls, upload table behavior, stream rows and field metadata, release behavior, invalid SQL, and missing table errors.
- Kingbase Oracle SQL semantics including `FROM dual`, `TO_TIMESTAMP_TZ(...)`, `FETCH NEXT`, placeholder-heavy filters, `IN` filters, and nested query filters.
- Driver-suite source queries and pre-aggregation paths using the existing `cubejs-testing` conventions.
- Server smoke queries through normal Cube API/server flow with `CUBEJS_DB_TYPE`, measures, dimensions, filters, ordering, limits, time dimensions, joins, and pre-aggregation reads.
- Tesseract real-database queries for rolling windows, period-to-date windows, multi-stage `group_by`, `reduce_by`, `add_group_by`, time shift, switch dimensions, and case measures on both Kingbase Targets.

## Known Limitations

- The local verification commands require the developer-managed Kingbase containers and password. They are not automated CI coverage unless compose-managed Kingbase services or CI secrets are added.
- Docker-mode birdbox runs are not wired for these local host-port containers. Use `--mode=local`.
- The Kingbase Oracle Target intentionally does not change global `OracleQuery`, global `PostgresQuery`, or global `PostgresDriver` behavior.
- Kingbase Oracle currently fails the generated source pre-aggregation DDL shape `CREATE TABLE ... SELECT ...` with a syntax error. Server smoke covers ordinary Kingbase Oracle API queries, filters, limits, time dimensions, and joins; Kingbase PG covers pre-aggregation build/read.
- Kingbase Oracle Tesseract coverage currently skips rolling windows without `dateRange` because that path returns `Date range is required for time series`.
- Kingbase Oracle Tesseract coverage currently skips bound filters on time-shift measures because generated Oracle-style timestamp placeholders fail after PG-wire normalization.
- The stream path currently relies on existing Postgres `pg` / `pg-query-stream` behavior. Add a tested Kingbase-specific override only if compatibility testing proves one is necessary.
- CubeSQL and Tesseract planner snapshots are not expanded by this slice because planner SQL generation is selected through existing dialect hooks rather than a planner rewrite.
