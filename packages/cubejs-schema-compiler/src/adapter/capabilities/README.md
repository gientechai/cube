# Query capabilities

Feature-specific SQL planning lives here — **not** in `BaseQuery.js`.

## Rules

1. New query features → new file under `capabilities/`, register in `install.js` (`QUERY_CAPABILITIES`), and add the method names to `queryCapabilities.d.ts`.
2. `BaseQuery` only orchestrates (path selection). Capabilities are installed onto `BaseQuery.prototype` via `installQueryCapabilities` — **do not** add hand-written thin delegates.
3. Database differences → dialect hooks on `*Query` classes (override methods on the prototype chain).
4. Cross-feature logic → a small bridge module (e.g. `periodAverageSemiAdditive.js`), not copy-paste; call via `this.*`.
5. Kernel primitives stay on `BaseQuery` / dialect hooks (`timeGroupedColumn`, `minGranularity`, `evaluateSql`, `applyMeasureFilters`, …).
6. Truly duplicated snippets → tiny util (e.g. `measureSqlUtils.js`), not a grab-bag commons module.

## Current modules

| File | Description |
|---|---|
| `install.js` | Mixin installer (`installQueryCapabilities`) |
| `queryCapabilities.d.ts` | Type augmentation for installed methods (keep names in sync) |
| `semiAdditive.js` | Point-in-time / `nonAdditiveDimension` measures |
| `periodAverage.js` | Period average (日均 / 月均等) measures |
| `periodAverageSemiAdditive.js` | Bridge: period_average × semi-additive collaboration |
| `measureFilter.js` | Outer measure-filter wrap (`HAVING` → subquery `WHERE`) |
| `measureSqlUtils.js` | Shared raw measure SQL projection (`rawMeasureSql`) |
