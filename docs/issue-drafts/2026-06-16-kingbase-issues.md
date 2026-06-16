# Kingbase Issue Drafts

These drafts are derived from parent issue #3, `CONTEXT.md`, ADR-0001 through ADR-0004, and the Kingbase Oracle placeholder prototype notes. Apply the `ready-for-agent` label when publishing.

Publishing is currently blocked by GitHub token permissions: `gh issue create` returned `GraphQL: Resource not accessible by personal access token (createIssue)`.

## 1. Register Kingbase Targets as first-class database types

## Parent

Parent: #3

## What to build

Add first-class Cube database type support for the **Kingbase PG Target** (`kingbase-pg`) and **Kingbase Oracle Target** (`kingbase-oracle`). These targets are not test aliases: users should be able to configure them through the normal Cube database type surface.

The key boundary from the design discussion is that server-core option validation whitelists explicit `DriverDependencies` keys, so these targets must be registered explicitly rather than relying only on package-name fallback. The package naming should follow the existing `@cubejs-backend/${type}-driver` convention so existing server and testing infrastructure can resolve them naturally.

Use the glossary terms in `CONTEXT.md`: **Kingbase Target**, **Kingbase PG Target**, **Kingbase Oracle Target**, **Driver Transport**, **SQL Dialect**, and **Kingbase Oracle Placeholder Normalization**.

## Acceptance criteria

- [ ] `kingbase-pg` and `kingbase-oracle` are accepted as valid Cube database types anywhere `CreateOptions.dbType` / `CUBEJS_DB_TYPE` is validated.
- [ ] `DriverDependencies` explicitly maps `kingbase-pg` and `kingbase-oracle` to target-specific driver packages.
- [ ] The implementation does not depend only on `packageExists(@cubejs-backend/${dbType}-driver)` fallback for these targets.
- [ ] Package names follow the existing convention: `@cubejs-backend/kingbase-pg-driver` and `@cubejs-backend/kingbase-oracle-driver`.
- [ ] Existing database type behavior and validation remain unchanged for Postgres, Oracle, Materialize, and other drivers.
- [ ] No local Kingbase credentials are added to source, docs, snapshots, or issue text.

## Blocked by

None - can start immediately

## 2. Add narrow target-specific Kingbase driver packages

## Parent

Parent: #3

## What to build

Add narrow public driver packages for the **Kingbase PG Target** and **Kingbase Oracle Target**. Both packages should reuse existing Postgres-compatible **Driver Transport** and avoid copying the Postgres driver implementation.

This slice should follow ADR-0002 and ADR-0004: expose target-specific public packages because the existing Cube driver ecosystem assumes one public driver package per database type, including `server-core` resolution and `cubejs-testing-drivers` imports. Shared internal wrapper code is acceptable when it reduces duplication, but each public target must remain independently resolvable.

Negative example to avoid: one `@cubejs-backend/kingbase-driver` default export with named driver classes. That fights existing `lookupDriverClass()` and `@cubejs-backend/${type}-driver` assumptions.

## Acceptance criteria

- [ ] `@cubejs-backend/kingbase-pg-driver` exists and can be resolved as the driver package for `kingbase-pg`.
- [ ] `@cubejs-backend/kingbase-oracle-driver` exists and can be resolved as the driver package for `kingbase-oracle`.
- [ ] Both driver packages reuse Postgres-compatible transport rather than forking/copying the Postgres driver.
- [ ] Kingbase PG behavior starts as close to existing Postgres driver behavior as possible.
- [ ] Kingbase Oracle behavior has a local home for **Kingbase Oracle Placeholder Normalization** and any future Kingbase Oracle execution-boundary behavior.
- [ ] Existing Postgres and Oracle driver packages are not modified to carry Kingbase-only behavior.

## Blocked by

Blocked by: issue 1

## 3. Expose Kingbase SQL dialect classes through driver hooks

## Parent

Parent: #3

## What to build

Expose Kingbase-specific **SQL Dialect** classes through each Kingbase driver package's `dialectClass()` hook.

The **Kingbase PG Target** should inherit from the closest Postgres query behavior. The **Kingbase Oracle Target** should inherit from the closest Oracle query behavior. This follows ADR-0003 and existing driver patterns where drivers such as Trino, QuestDB, and Dremio carry their own query classes or expose schema-compiler query classes through `dialectClass()`.

Do not require `schema-compiler` to import Kingbase driver packages. The dependency direction should remain consistent with existing drivers: driver packages may depend on `@cubejs-backend/schema-compiler`, but schema-compiler should not depend on Kingbase packages.

## Acceptance criteria

- [ ] The Kingbase PG driver package exposes a dialect class through `static dialectClass()`.
- [ ] The Kingbase Oracle driver package exposes a dialect class through `static dialectClass()`.
- [ ] Kingbase PG SQL generation inherits existing Postgres semantics unless a tested Kingbase difference requires an override.
- [ ] Kingbase Oracle SQL generation inherits existing Oracle semantics unless a tested Kingbase difference requires an override.
- [ ] No global Postgres or Oracle query-generation behavior changes for Kingbase-only needs.
- [ ] Server-level query generation can instantiate the correct Kingbase dialect through the existing `dialectFactory` / `dialectClass()` path.

## Blocked by

Blocked by: issue 2

## 4. Implement Kingbase Oracle Placeholder Normalization

## Parent

Parent: #3

## What to build

Implement **Kingbase Oracle Placeholder Normalization** only on the **Kingbase Oracle Target** path, after Oracle-style SQL has been generated and before execution through Postgres-compatible **Driver Transport**.

The core rule from ADR-0001 is narrowness: do not change global Oracle query generation and do not change global Postgres driver behavior. Normalize only the Kingbase Oracle execution boundary.

The prototype showed that regex-only replacement is too fragile. The implementation should use scanner-style logic that tracks SQL text state and skips quoted strings, double-quoted identifiers, line comments, and block comments. The decision-rich part of the prototype was this state model:

```text
State while scanning SQL:
- normal SQL text
- inside single-quoted string
- inside double-quoted identifier
- inside line comment
- inside block comment

Only in normal SQL text:
- positional Oracle bind token :\"?\" becomes the next $n
- repeated named Oracle bind token :\"name\" reuses the same $n
```

Positive examples from the prototype:

- `status = :\"?\" and amount > :\"?\"` -> `status = $1 and amount > $2`
- `created_at >= :\"from\" and updated_at >= :\"from\"` -> both use `$1`
- `id in (:\"?\", :\"?\", :\"?\")` -> `$1, $2, $3`
- `TO_TIMESTAMP_TZ(:\"?\", 'YYYY-MM-DD\"T\"HH24:MI:SS.FF\"Z\"')` -> `TO_TIMESTAMP_TZ($1, ...)`

Negative examples to protect:

- `':\"?\"'` inside a string must not change.
- `\"literal :\"\"?\"\"\"` inside a quoted identifier must not change.
- `-- keep :\"?\"` in a line comment must not change.
- `/* keep :\"?\" */` in a block comment must not change.

## Acceptance criteria

- [ ] Kingbase Oracle normalizes Oracle-style placeholders to `$n` placeholders accepted by Postgres-compatible transport.
- [ ] Positional binds preserve parameter order.
- [ ] Repeated named binds reuse the same placeholder index and value.
- [ ] Normalization skips single-quoted strings, double-quoted identifiers, line comments, and block comments.
- [ ] Placeholder normalization applies to `query`, `stream`, `downloadQueryResults`, upload/pre-aggregation paths, and any other execution boundary that receives generated SQL plus values.
- [ ] Global `OracleQuery`, global `PostgresQuery`, and global `PostgresDriver` behavior remain unchanged.
- [ ] Tests cover filters, range filters, `IN` filters, nested queries, limits, timestamp casts, pre-aggregation paths, and quoted/commented false positives.

## Blocked by

Blocked by: issues 2 and 3

## 5. Add low-level Kingbase driver compatibility tests

## Parent

Parent: #3

## What to build

Add low-level compatibility tests for the **Kingbase PG Target** and **Kingbase Oracle Target** through the target driver packages.

These tests should turn the prototype and local verification results into durable coverage. Local verification found that both Kingbase modes accepted `SELECT $1::int AS number`; Kingbase Oracle accepted `SELECT $1 AS value FROM dual`, `TO_TIMESTAMP_TZ($1, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF\"Z\"')`, `FETCH NEXT`, `SET TIME ZONE`, and `SET statement_timeout`; both modes accepted the Postgres driver-style upload SQL `INSERT ... SELECT * FROM UNNEST($1::text[], $2::int8[])`; and `pg-query-stream` worked with bound `$n` parameters.

Important stream boundary: `pg-query-stream` is not a new Kingbase-specific dependency. The existing Postgres driver already depends on `pg` and `pg-query-stream`, and `PostgresDriver.stream()` uses `pg-query-stream` on top of a `pg` connection. Kingbase wrappers should reuse that existing stream path unless tests prove an override is needed.

## Acceptance criteria

- [ ] `testConnection` succeeds for both Kingbase targets.
- [ ] Typed scalar queries cover integer, decimal/numeric, text/string, timestamp/date, boolean where supported, and null handling.
- [ ] Kingbase Oracle tests cover Oracle SQL semantics that were locally verified: `FROM dual`, `TO_TIMESTAMP_TZ($n, ...)`, `FETCH NEXT`, and Postgres-compatible bind placeholders after normalization.
- [ ] Upload table tests cover Postgres driver-style `UNNEST($1::text[], $2::int8[])` behavior for both modes.
- [ ] Stream tests cover the existing Postgres `pg-query-stream` path for both modes, including streamed row values and field type metadata.
- [ ] User-defined type discovery / field type mapping is covered enough to prevent unknown type IDs for common result types.
- [ ] Negative tests cover invalid SQL, missing tables, parameter count limits/errors, and actionable error propagation.
- [ ] Driver release behavior is tested.
- [ ] No secrets from local Kingbase setup are committed, logged, or snapshotted.

## Blocked by

Blocked by: issues 2 and 4

## 6. Add driver test suite coverage for Kingbase Targets

## Parent

Parent: #3

## What to build

Extend the existing driver compatibility framework so the **Kingbase PG Target** and **Kingbase Oracle Target** can run thin end-to-end slices equivalent to `postgres-driver`, `postgres-core`, and `postgres-full`.

This is the bridge from low-level driver behavior to Cube's driver test suite conventions. It should respect the existing `cubejs-testing-drivers` package naming assumption (`@cubejs-backend/${type}-driver`) and the target-specific package decision from ADR-0004.

Local environment boundary: the current Kingbase containers are already running on host ports `54321` for Oracle compatibility mode and `54322` for PG compatibility mode. In docker-mode tests, `127.0.0.1` from inside a Cube container is not the host. Use `--mode=local` for the local containers unless this issue also adds compose-managed Kingbase services.

## Acceptance criteria

- [ ] Driver test suite scripts exist for `kingbase-pg` and `kingbase-oracle`.
- [ ] Fixtures can connect to the local Kingbase targets without storing credentials in source-controlled files.
- [ ] Tests follow existing driver test suite conventions and snapshot hygiene.
- [ ] The suite covers source queries and internal/external pre-aggregation paths where feasible.
- [ ] Placeholder-heavy Kingbase Oracle cases are included beyond trivial `SELECT 1`.
- [ ] Local verification docs or script output make clear when `--mode=local` is required.
- [ ] No source-controlled fixture, snapshot, or log includes the local password from `~/kingbase/Agents.md`.

## Blocked by

Blocked by: issues 1, 2, 4, and 5

## 7. Add server smoke coverage for Kingbase Targets

## Parent

Parent: #3

## What to build

Add server-level smoke tests for the **Kingbase PG Target** and **Kingbase Oracle Target**. These should exercise Cube behavior through the API/server flow rather than only through direct driver calls.

The goal is a narrow but complete server slice: configure the target through `CUBEJS_DB_TYPE`, run Cube schema queries, verify generated SQL is accepted by the database, and validate result shape/values. Kingbase Oracle smoke coverage should include placeholder-heavy paths because that is the highest-risk integration boundary.

CubeSQL and Tesseract planner coverage should be added only where implementation changes generated SQL/planner behavior, dialect behavior, placeholder rendering, joins, or pre-aggregation SQL. Do not add broad planner snapshot churn if the implementation only wires driver packages and execution-boundary normalization.

## Acceptance criteria

- [ ] Smoke tests exist for `kingbase-pg` and `kingbase-oracle`.
- [ ] Smoke tests configure targets through normal Cube database variables, including `CUBEJS_DB_TYPE`.
- [ ] Query coverage includes measures, dimensions, filters, order, limits, time dimensions/date truncation, and joins.
- [ ] Pre-aggregation create/build/read paths are covered where Kingbase supports the generated DDL/DML.
- [ ] Kingbase Oracle smoke tests include placeholder-heavy filters, ranges, `IN`, nested query filters, limits, and pre-aggregation queries.
- [ ] CubeSQL/Tesseract tests are added only if generated SQL or planner behavior changes.
- [ ] Existing Postgres, Oracle, and CubeSQL smoke tests continue to pass without Kingbase-specific regressions.
- [ ] No credentials are committed, logged, or snapshotted.

## Blocked by

Blocked by: issues 1, 2, 3, and 4

## 8. Document local verification and known limitations

## Parent

Parent: #3

## What to build

Document how to verify the **Kingbase PG Target** and **Kingbase Oracle Target** locally, plus known limitations discovered by implementation and tests.

The documentation should be explicit about the local container context from the PRD without publishing credentials: Kingbase Oracle compatibility mode is on `127.0.0.1:54321`; Kingbase PG compatibility mode is on `127.0.0.1:54322`; database is `kingbase`; user is `system`; password remains local-only in `~/kingbase/Agents.md`.

Carry forward the important conclusions from the design/prototype work:

- Kingbase targets are first-class database types, not test aliases.
- Both targets use Postgres-compatible **Driver Transport**.
- Kingbase PG uses Postgres **SQL Dialect** semantics.
- Kingbase Oracle uses Oracle **SQL Dialect** semantics plus **Kingbase Oracle Placeholder Normalization** at the execution boundary.
- `pg-query-stream` is already part of the existing Postgres driver stream path, not a new Kingbase-only dependency.
- Local driver-suite runs against host ports should use `--mode=local` unless compose-managed Kingbase services are added.

## Acceptance criteria

- [ ] Documentation includes a local verification command sequence for both Kingbase targets.
- [ ] Documentation explains which environment variables are required and where the password should come from without printing or committing the password.
- [ ] Documentation explains `kingbase-pg` and `kingbase-oracle` semantics using glossary terms from `CONTEXT.md`.
- [ ] Documentation lists known limitations and unsupported features found during compatibility testing.
- [ ] Documentation distinguishes local verification proof from automated CI/test-suite coverage.
- [ ] Documentation mentions that stream behavior reuses existing Postgres `pg` / `pg-query-stream` behavior unless a tested override is introduced.
- [ ] No local secrets are added to docs, tests, snapshots, or issue text.

## Blocked by

Blocked by: issues 5, 6, and 7
