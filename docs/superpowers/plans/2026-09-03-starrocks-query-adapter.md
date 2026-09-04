# StarRocks Query Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `StarRocksQuery` (extends `MysqlQuery`) with Tesseract generated time-series templates that use `TABLE(generate_series)` + Jinja granularity branches (DmQuery-style), and wire `dbType: 'starrocks'` end-to-end.

**Architecture:** Thin MySQL subclass for dialect reuse; override only `sqlTemplates()` time-series statements (and keep `supportGeneratedSeriesForCustomTd()` true). Register in `QueryBuilder`, add `DatabaseType` + mysql-driver mapping, point integration `dbTypeMap` at `starrocks`.

**Tech Stack:** TypeScript, `@cubejs-backend/schema-compiler`, Jest unit tests, StarRocks SQL (`generate_series`, `DATE_ADD`, `months_add` / month INTERVAL).

**Spec:** `docs/superpowers/specs/2026-09-03-starrocks-query-adapter-design.md`

## Global Constraints

- Inherit `MysqlQuery`; do not extend `OracleQuery` / copy DM CONNECT BY.
- Do not emit `WITH RECURSIVE` in StarRocks generated time-series templates.
- Granularity Jinja branches must cover at least: `1 second`, `1 minute`, `1 hour`, `1 day`, `1 week`, `1 month`, `3 month`, `1 quarter`, `1 year`, plus `{% else %}` day fallback (same set as DmQuery 296–344).
- Level generator: `TABLE(generate_series(1, <limit>))` aliased so level column is usable as `gen.generate_series` (or explicit alias `lv` if preferred—pick one and use consistently in templates and tests).
- Prefer `DATE_SUB(..., INTERVAL 1 SECOND)` for `date_to` end (avoid MICROSECOND-only paths).
- StarRocks version floor for this feature: **≥ 3.1** (`generate_series`).
- No separate starrocks-driver package; `DriverDependencies.starrocks` → `@cubejs-backend/mysql-driver`.
- Do not commit unless the user explicitly asks.

## File map

| File | Responsibility |
|------|----------------|
| `packages/cubejs-schema-compiler/src/adapter/StarRocksQuery.ts` | New adapter: helpers + `sqlTemplates()` overrides |
| `packages/cubejs-schema-compiler/src/adapter/QueryBuilder.ts` | Register `starrocks: StarRocksQuery` |
| `packages/cubejs-schema-compiler/test/unit/starrocks-query.test.ts` | Unit tests for templates / registration behavior |
| `packages/cubejs-server-core/src/core/types.ts` | Add `'starrocks'` to `DatabaseType` |
| `packages/cubejs-server-core/src/core/DriverDependencies.ts` | Map starrocks → mysql-driver |
| `cubejs/test/metrics-measures-matrix.integration.test.js` | `dbTypeMap.starrocks = 'starrocks'` (both maps) |

---

### Task 1: Failing unit tests for StarRocks generated time-series templates

**Files:**
- Create: `packages/cubejs-schema-compiler/test/unit/starrocks-query.test.ts`
- Test: same file (run via package unit jest)

**Interfaces:**
- Consumes: `prepareJsCompiler` from `./PrepareCompiler`; will import `StarRocksQuery` (not yet implemented)
- Produces: assertions that lock template contracts for Task 2

- [ ] **Step 1: Write the failing test file**

Create `packages/cubejs-schema-compiler/test/unit/starrocks-query.test.ts`:

```ts
/* eslint-disable no-restricted-syntax */
import { StarRocksQuery } from '../../src/adapter/StarRocksQuery';
import { createQuery } from '../../src/adapter/QueryBuilder';
import { prepareJsCompiler } from './PrepareCompiler';

describe('StarRocksQuery', () => {
  const { compiler, joinGraph, cubeEvaluator } = prepareJsCompiler(
    `
    cube(\`visitors\`, {
      sql: \`select * from visitors\`,
      measures: {
        count: {
          type: 'count'
        }
      },
      dimensions: {
        createdAt: {
          type: 'time',
          sql: 'created_at'
        }
      }
    })
    `,
    { adapter: 'starrocks' }
  );

  const compilers = () => ({ joinGraph, cubeEvaluator, compiler });

  it('is registered for dbType starrocks via createQuery', async () => {
    await compiler.compile();
    const query = createQuery(compilers(), 'starrocks', {
      measures: ['visitors.count'],
      timezone: 'UTC',
    });
    expect(query).toBeInstanceOf(StarRocksQuery);
  });

  it('sqlTemplates: generated time series uses generate_series, not WITH RECURSIVE', async () => {
    await compiler.compile();
    const query = new StarRocksQuery(compilers(), {
      measures: ['visitors.count'],
      timezone: 'UTC',
    });
    const templates = query.sqlTemplates();

    expect(templates.statements.generated_time_series_select).toContain('generate_series');
    expect(templates.statements.generated_time_series_select).toContain('TABLE(');
    expect(templates.statements.generated_time_series_select).not.toContain('WITH RECURSIVE');
    expect(templates.statements.generated_time_series_select).not.toContain('CONNECT BY');
    expect(templates.statements.generated_time_series_select).not.toContain('NUMTODSINTERVAL');
    expect(templates.statements.generated_time_series_select).not.toContain('ADD_MONTHS');
    expect(templates.statements.generated_time_series_select).not.toContain('MONTHS_BETWEEN');

    // Jinja granularity branches (DmQuery parity)
    expect(templates.statements.generated_time_series_select).toContain("g == '1 second'");
    expect(templates.statements.generated_time_series_select).toContain("g == '1 minute'");
    expect(templates.statements.generated_time_series_select).toContain("g == '1 hour'");
    expect(templates.statements.generated_time_series_select).toContain("g == '1 day'");
    expect(templates.statements.generated_time_series_select).toContain("g == '1 week'");
    expect(templates.statements.generated_time_series_select).toContain("g == '1 month'");
    expect(templates.statements.generated_time_series_select).toContain("g == '3 month'");
    expect(templates.statements.generated_time_series_select).toContain("g == '1 quarter'");
    expect(templates.statements.generated_time_series_select).toContain("g == '1 year'");

    expect(templates.statements.generated_time_series_with_cte_range_source).toContain('generate_series');
    expect(templates.statements.generated_time_series_with_cte_range_source).toContain('{{ range_source }}');
    expect(templates.statements.generated_time_series_with_cte_range_source).toContain('bounds');
    expect(templates.statements.generated_time_series_with_cte_range_source).not.toContain('WITH RECURSIVE');
  });

  it('inherits MySQL identifier quotes and disables FULL JOIN', async () => {
    await compiler.compile();
    const query = new StarRocksQuery(compilers(), {
      measures: ['visitors.count'],
      timezone: 'UTC',
    });
    const templates = query.sqlTemplates();
    expect(templates.quotes.identifiers).toBe('`');
    expect(templates.join_types.full).toBeUndefined();
  });

  it('supportGeneratedSeriesForCustomTd is true', async () => {
    await compiler.compile();
    const query = new StarRocksQuery(compilers(), {
      measures: ['visitors.count'],
      timezone: 'UTC',
    });
    expect(query.supportGeneratedSeriesForCustomTd()).toBe(true);
  });
});
```

- [ ] **Step 2: Run unit test and confirm it fails (module missing)**

From repo root (or package dir):

```bash
cd packages/cubejs-schema-compiler
yarn tsc
TZ=UTC yarn jest dist/test/unit/starrocks-query.test.js --runInBand
```

If jest is configured on `src` via ts-jest in this package, use the package’s usual path:

```bash
TZ=UTC yarn unit --testPathPattern=starrocks-query
```

Expected: FAIL — `Cannot find module '../../src/adapter/StarRocksQuery'` or compile error.

- [ ] **Step 3: Stop here for this task** — implementation is Task 2.

---

### Task 2: Implement `StarRocksQuery` + register in `QueryBuilder`

**Files:**
- Create: `packages/cubejs-schema-compiler/src/adapter/StarRocksQuery.ts`
- Modify: `packages/cubejs-schema-compiler/src/adapter/QueryBuilder.ts`
- Test: `packages/cubejs-schema-compiler/test/unit/starrocks-query.test.ts`

**Interfaces:**
- Consumes: `MysqlQuery` from `./MysqlQuery`
- Produces: `export class StarRocksQuery extends MysqlQuery` with `sqlTemplates()` overrides; `ADAPTERS.starrocks`

- [ ] **Step 1: Add `StarRocksQuery.ts` with private helpers mirroring DmQuery structure**

Create `packages/cubejs-schema-compiler/src/adapter/StarRocksQuery.ts`. Recommended body (adjust only if StarRocks rejects a function name during IT):

```ts
/**
 * StarRocks query adapter: extends MysqlQuery.
 *
 * Reuses MySQL for quotes, seriesSql (UNION ALL), period_average, FULL JOIN disable, etc.
 * Overrides Tesseract generated_time_series_* : StarRocks cannot safely use MySQL WITH RECURSIVE
 * (4.1+ flag, default depth 5). Use TABLE(generate_series) + Jinja-branched DATE_ADD / months_add
 * (same control-flow shape as DmQuery generatedTimeSeries* helpers).
 */
import { MysqlQuery } from './MysqlQuery';

export class StarRocksQuery extends MysqlQuery {
  public supportGeneratedSeriesForCustomTd(): boolean {
    return true;
  }

  private static generatedTimeSeriesDateAnchor(column: string): string {
    return `CAST(${column} AS DATETIME)`;
  }

  /**
   * Level expression: generate_series column from TABLE(generate_series(1, N)) AS gen.
   * StarRocks names the output column `generate_series` by default.
   */
  private static levelExpr(alias = 'gen'): string {
    return `${alias}.generate_series`;
  }

  private static generatedTimeSeriesDateFromAtLevel(
    anchor: string,
    levelExpr = StarRocksQuery.levelExpr(),
  ): string {
    return '{% set g = granularity | replace("\'", "") | trim %}'
      + `{% if g == '1 second' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) SECOND)`
      + `{% elif g == '1 minute' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) MINUTE)`
      + `{% elif g == '1 hour' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) HOUR)`
      + `{% elif g == '1 day' %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) DAY)`
      + `{% elif g == '1 week' %}DATE_ADD(${anchor}, INTERVAL ((${levelExpr} - 1) * 7) DAY)`
      + `{% elif g == '1 month' %}months_add(${anchor}, ${levelExpr} - 1)`
      + `{% elif g == '3 month' %}months_add(${anchor}, (${levelExpr} - 1) * 3)`
      + `{% elif g == '1 quarter' %}months_add(${anchor}, (${levelExpr} - 1) * 3)`
      + `{% elif g == '1 year' %}months_add(${anchor}, (${levelExpr} - 1) * 12)`
      + `{% else %}DATE_ADD(${anchor}, INTERVAL (${levelExpr} - 1) DAY){% endif %}`;
  }

  private static generatedTimeSeriesDateToAtLevel(
    anchor: string,
    levelExpr = StarRocksQuery.levelExpr(),
  ): string {
    // date_to = start of next bucket - 1 second
    return '{% set g = granularity | replace("\'", "") | trim %}'
      + `{% if g == '1 second' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} SECOND), INTERVAL 1 SECOND)`
      + `{% elif g == '1 minute' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} MINUTE), INTERVAL 1 SECOND)`
      + `{% elif g == '1 hour' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} HOUR), INTERVAL 1 SECOND)`
      + `{% elif g == '1 day' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} DAY), INTERVAL 1 SECOND)`
      + `{% elif g == '1 week' %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL (${levelExpr} * 7) DAY), INTERVAL 1 SECOND)`
      + `{% elif g == '1 month' %}DATE_SUB(months_add(${anchor}, ${levelExpr}), INTERVAL 1 SECOND)`
      + `{% elif g == '3 month' %}DATE_SUB(months_add(${anchor}, ${levelExpr} * 3), INTERVAL 1 SECOND)`
      + `{% elif g == '1 quarter' %}DATE_SUB(months_add(${anchor}, ${levelExpr} * 3), INTERVAL 1 SECOND)`
      + `{% elif g == '1 year' %}DATE_SUB(months_add(${anchor}, ${levelExpr} * 12), INTERVAL 1 SECOND)`
      + `{% else %}DATE_SUB(DATE_ADD(${anchor}, INTERVAL ${levelExpr} DAY), INTERVAL 1 SECOND){% endif %}`;
  }

  private static generatedTimeSeriesLevelLimit(minCol: string, maxCol: string): string {
    const minTs = `CAST(${minCol} AS DATETIME)`;
    const maxTs = `CAST(${maxCol} AS DATETIME)`;
    return '{% set g = granularity | replace("\'", "") | trim %}'
      + `{% if g == '1 second' %}TIMESTAMPDIFF(SECOND, ${minTs}, ${maxTs}) + 1`
      + `{% elif g == '1 minute' %}TIMESTAMPDIFF(MINUTE, ${minTs}, ${maxTs}) + 1`
      + `{% elif g == '1 hour' %}TIMESTAMPDIFF(HOUR, ${minTs}, ${maxTs}) + 1`
      + `{% elif g == '1 day' %}DATEDIFF(${maxTs}, ${minTs}) + 1`
      + `{% elif g == '1 week' %}FLOOR(DATEDIFF(${maxTs}, ${minTs}) / 7) + 1`
      + `{% elif g == '1 month' %}TIMESTAMPDIFF(MONTH, ${minTs}, ${maxTs}) + 1`
      + `{% elif g == '3 month' %}FLOOR(TIMESTAMPDIFF(MONTH, ${minTs}, ${maxTs}) / 3) + 1`
      + `{% elif g == '1 quarter' %}FLOOR(TIMESTAMPDIFF(MONTH, ${minTs}, ${maxTs}) / 3) + 1`
      + `{% elif g == '1 year' %}TIMESTAMPDIFF(YEAR, ${minTs}, ${maxTs}) + 1`
      + `{% else %}DATEDIFF(${maxTs}, ${minTs}) + 1{% endif %}`;
  }

  private static generatedTimeSeriesSeriesJoin(levelLimitSql: string): string {
    return `CROSS JOIN TABLE(generate_series(1, ${levelLimitSql})) AS gen`;
  }

  private static generatedTimeSeriesSelectTemplate(): string {
    const anchor = StarRocksQuery.generatedTimeSeriesDateAnchor('{{ start }}');
    const levelLimit = StarRocksQuery.generatedTimeSeriesLevelLimit('{{ start }}', '{{ end }}');
    return 'SELECT\n'
      + `  ${StarRocksQuery.generatedTimeSeriesDateFromAtLevel(anchor)} AS date_from,\n`
      + `  ${StarRocksQuery.generatedTimeSeriesDateToAtLevel(anchor)} AS date_to\n`
      + 'FROM (SELECT 1) AS _sr_dual\n'
      + `${StarRocksQuery.generatedTimeSeriesSeriesJoin(levelLimit)}`;
  }

  private static generatedTimeSeriesWithCteRangeSourceTemplate(): string {
    const boundsMin = 'bounds.`{{ min_name }}`';
    const anchor = StarRocksQuery.generatedTimeSeriesDateAnchor(boundsMin);
    const levelLimit = StarRocksQuery.generatedTimeSeriesLevelLimit(
      '{{ range_source }}.`{{ min_name }}`',
      '{{ range_source }}.`{{ max_name }}`',
    );
    // If Tesseract already quotes min/max names, prefer unquoted {{ min_name }} like MysqlQuery/DmQuery.
    // Prefer DmQuery-style placeholders without forced backticks if compile shows double-quoting:
    // use bounds.{{ min_name }} / {{ range_source }}.{{ min_name }} to match DmQuery.
    return 'SELECT\n'
      + `  ${StarRocksQuery.generatedTimeSeriesDateFromAtLevel(StarRocksQuery.generatedTimeSeriesDateAnchor('bounds.{{ min_name }}'))} AS date_from,\n`
      + `  ${StarRocksQuery.generatedTimeSeriesDateToAtLevel(StarRocksQuery.generatedTimeSeriesDateAnchor('bounds.{{ min_name }}'))} AS date_to\n`
      + 'FROM (\n'
      + '  SELECT {{ range_source }}.{{ min_name }} AS {{ min_name }}, {{ range_source }}.{{ max_name }} AS {{ max_name }}\n'
      + '  FROM {{ range_source }}\n'
      + ') bounds\n'
      + `${StarRocksQuery.generatedTimeSeriesSeriesJoin(
        StarRocksQuery.generatedTimeSeriesLevelLimit(
          'bounds.{{ min_name }}',
          'bounds.{{ max_name }}',
        ),
      )}`;
  }

  public sqlTemplates() {
    const templates = super.sqlTemplates();
    templates.statements.generated_time_series_select =
      StarRocksQuery.generatedTimeSeriesSelectTemplate();
    templates.statements.generated_time_series_with_cte_range_source =
      StarRocksQuery.generatedTimeSeriesWithCteRangeSourceTemplate();
    return templates;
  }
}
```

**Implementer note:** Clean up the unused `boundsMin` / first `levelLimit` locals; keep **one** consistent placeholder style matching `DmQuery` (`bounds."{{ min_name }}"` vs MySQL backticks). Prefer:

- anchors: `CAST(bounds.{{ min_name }} AS DATETIME)`  
- level limit from bounds columns: `bounds.{{ min_name }}`, `bounds.{{ max_name }}`  
- Do **not** leave dead code or contradictory backtick variants in the final file.

Simplified final `generatedTimeSeriesWithCteRangeSourceTemplate` (use this):

```ts
  private static generatedTimeSeriesWithCteRangeSourceTemplate(): string {
    const anchor = StarRocksQuery.generatedTimeSeriesDateAnchor('bounds.{{ min_name }}');
    const levelLimit = StarRocksQuery.generatedTimeSeriesLevelLimit(
      'bounds.{{ min_name }}',
      'bounds.{{ max_name }}',
    );
    return 'SELECT\n'
      + `  ${StarRocksQuery.generatedTimeSeriesDateFromAtLevel(anchor)} AS date_from,\n`
      + `  ${StarRocksQuery.generatedTimeSeriesDateToAtLevel(anchor)} AS date_to\n`
      + 'FROM (\n'
      + '  SELECT {{ range_source }}.{{ min_name }} AS {{ min_name }}, {{ range_source }}.{{ max_name }} AS {{ max_name }}\n'
      + '  FROM {{ range_source }}\n'
      + ') bounds\n'
      + `${StarRocksQuery.generatedTimeSeriesSeriesJoin(levelLimit)}`;
  }
```

- [ ] **Step 2: Register in QueryBuilder**

In `packages/cubejs-schema-compiler/src/adapter/QueryBuilder.ts`:

```ts
import { StarRocksQuery } from './StarRocksQuery';

const ADAPTERS = {
  // ...existing...
  mysql: MysqlQuery,
  starrocks: StarRocksQuery,
  // ...
  dm: DmQuery,
};
```

- [ ] **Step 3: Compile and run unit tests**

```bash
cd packages/cubejs-schema-compiler
yarn tsc
TZ=UTC yarn unit --testPathPattern=starrocks-query
```

Expected: all `StarRocksQuery` tests PASS.

Also re-run a quick smoke that mysql/dm still register:

```bash
TZ=UTC yarn unit --testPathPattern='dm-query|mysql' --coverage=false
```

Expected: existing tests still PASS (no regressions from QueryBuilder import).

- [ ] **Step 4: Commit only if user requests** (do not auto-commit).

---

### Task 3: Wire `DatabaseType` + driver dependency for `starrocks`

**Files:**
- Modify: `packages/cubejs-server-core/src/core/types.ts`
- Modify: `packages/cubejs-server-core/src/core/DriverDependencies.ts`

**Interfaces:**
- Consumes: `StarRocksQuery` registration from Task 2 (schema-compiler)
- Produces: `DatabaseType` includes `'starrocks'`; `DriverDependencies.starrocks === '@cubejs-backend/mysql-driver'`

- [ ] **Step 1: Extend DatabaseType**

In `packages/cubejs-server-core/src/core/types.ts`, add `'starrocks'` next to `'mysql'`:

```ts
  | 'mysql'
  | 'starrocks'
  | 'mysqlauroraserverless'
```

- [ ] **Step 2: Map driver package**

In `packages/cubejs-server-core/src/core/DriverDependencies.ts`:

```ts
  mysql: '@cubejs-backend/mysql-driver',
  starrocks: '@cubejs-backend/mysql-driver',
```

- [ ] **Step 3: Typecheck server-core**

```bash
cd packages/cubejs-server-core && yarn tsc
```

Expected: PASS (Record\<DatabaseType, string\> still satisfied).

---

### Task 4: Point integration matrix `dbType` at `starrocks`

**Files:**
- Modify: `cubejs/test/metrics-measures-matrix.integration.test.js` (both `dbTypeMap` objects that currently set `starrocks: 'mysql'`)

**Interfaces:**
- Consumes: `createQuery` / server-core `dbType: 'starrocks'` → `StarRocksQuery`
- Produces: IT process uses StarRocks templates when `CUBEJS_TEST_DRIVER=starrocks`

- [ ] **Step 1: Update both dbTypeMap entries**

Find (approx lines ~1489 and ~2966):

```js
starrocks: 'mysql',
```

Replace with:

```js
starrocks: 'starrocks',
```

Keep driver factory still using `@cubejs-backend/mysql-driver` for the `case 'starrocks'` connection.

- [ ] **Step 2: Manual smoke (optional if SR available)**

```bash
cd cubejs
CUBEJS_TEST_DRIVER=starrocks \
CUBEJS_TEST_HOST=... CUBEJS_TEST_PORT=9030 \
CUBEJS_TEST_USER=root CUBEJS_TEST_PASSWORD=... \
CUBEJS_TEST_DATABASE=test \
NODE_OPTIONS=--openssl-legacy-provider \
yarn test test/metrics-measures-matrix.integration.test.js --runTestsByPath
```

Expected: setup proceeds; rolling / generated time-series SQL contains `generate_series` and not `WITH RECURSIVE`. If `months_add` / `TIMESTAMPDIFF` naming differs on the cluster version, fix `StarRocksQuery` helpers and re-run unit assertions.

---

## Self-review

1. **Spec coverage:** generate_series + Jinja branches; no WITH RECURSIVE; MysqlQuery inheritance; QueryBuilder; DatabaseType/DriverDependencies; IT dbTypeMap — all have tasks.  
2. **Placeholders:** Template code is concrete; note on quote style resolved to DmQuery-like `bounds.{{ min_name }}`.  
3. **Consistency:** Level column is `gen.generate_series` everywhere; tests assert that via `generate_series` substring.

## Execution handoff

Plan saved to `docs/superpowers/plans/2026-09-03-starrocks-query-adapter.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
