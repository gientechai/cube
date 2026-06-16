# Kingbase Placeholder Prototype Notes

Question: can **Kingbase Oracle Placeholder Normalization** convert Oracle-style bind tokens to Postgres-compatible placeholders while preserving parameter order and avoiding quoted SQL text?

Verdict: the prototype starts successfully and all built-in scenarios normalized as expected. Positional binds preserve order, named/reused binds reuse the same `$n`, `IN` lists increment in order, quoted literals are not rewritten, timestamp format strings remain intact, double-quoted identifiers are not rewritten, and line/block comments are not rewritten. The implementation should use a small SQL scanner rather than regex-only replacement, and should turn these scenarios into focused tests rather than relying on the prototype.

`yarn prototype:kingbase-placeholder` is wired in the root package scripts and was verified with Yarn 1.22.19.

Additional local verification: using the Node `pg` client against the running Kingbase containers, both Kingbase modes accepted `SELECT $1::int AS number`. Kingbase Oracle mode also accepted `SELECT $1 AS value FROM dual`, `TO_TIMESTAMP_TZ($1, 'YYYY-MM-DD"T"HH24:MI:SS.FF"Z"')`, `FETCH NEXT`, `SET TIME ZONE`, and `SET statement_timeout`. The implementation still needs automated tests for these paths because the current proof is against the local V009R001C010 containers only.

Additional challenge results: the Postgres driver-style upload path `INSERT ... SELECT * FROM UNNEST($1::text[], $2::int8[])` worked against both local Kingbase modes. Kingbase Oracle mode also accepted the Postgres driver user-defined-type discovery queries against `pg_catalog`, and returned expected field type IDs for integer, decimal, text, and timestamp values. These results reduce the need for early driver-method overrides, but they should become automated compatibility tests.

Stream challenge result: `pg-query-stream` worked against both local Kingbase modes with bound `$n` parameters. This does not imply a new Kingbase-specific streaming dependency: the existing Postgres driver already depends on `pg` and `pg-query-stream`, and its `stream()` implementation uses `pg-query-stream` on top of a `pg` connection. Kingbase wrappers should reuse the existing Postgres driver stream path unless compatibility tests prove a Kingbase-specific override is needed. Formal driver tests should still assert streamed row values and field type metadata through the actual Kingbase wrapper classes.
