# StarRocks Query Adapter Design

**Date:** 2026-09-03  
**Status:** Approved (option A)

## Problem

StarRocks is wired in integration tests with `dbType: 'mysql'`, so Tesseract uses `MysqlQuery` templates. MySQL’s `generated_time_series_*` uses `WITH RECURSIVE`, which StarRocks only supports from ~4.1 (flag + default depth 5). Rolling windows / no-dateRange time axes fail or are unsafe on typical 3.x clusters.

## Decision

Add `StarRocksQuery extends MysqlQuery`. Reuse MySQL for identifiers, `seriesSql`, period_average, join_types, etc. Override Tesseract `generated_time_series_select` and `generated_time_series_with_cte_range_source` using:

1. Integer sequence: `TABLE(generate_series(1, N))` (StarRocks ≥ 3.1)
2. Jinja branches by granularity (same structure as `DmQuery` private helpers ~296–344), with StarRocks functions:
   - `DATE_ADD(..., INTERVAL n SECOND|MINUTE|HOUR|DAY)`
   - `months_add` / `DATE_ADD(..., INTERVAL n MONTH|QUARTER|YEAR)`
   - level count via `DATEDIFF` / `TIMESTAMPDIFF` / month math
   - `date_to` = next bucket start minus `INTERVAL 1 SECOND`

Do **not** use Oracle `CONNECT BY` / `DUAL` / `NUMTODSINTERVAL` / `ADD_MONTHS` / `MONTHS_BETWEEN`.

## Non-goals (this iteration)

- Separate `@cubejs-backend/starrocks-driver` package (map `starrocks` → mysql-driver)
- DM-only workarounds (short aliases, `overTimeSeriesSelect` CTE rename)
- datetime-typed `generate_series` as primary path

## Wiring

- `QueryBuilder.ADAPTERS.starrocks = StarRocksQuery`
- `DatabaseType` includes `'starrocks'`
- `DriverDependencies.starrocks = '@cubejs-backend/mysql-driver'`
- Integration tests: `dbTypeMap.starrocks = 'starrocks'` (not `'mysql'`)
