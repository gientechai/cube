# 半累加（时点）指标 SQL 生成方案优化 — 改动方案（审批稿）

| 项目 | 内容 |
|------|------|
| **文档版本** | v1.0 |
| **文档类型** | 重要改动方案 / 领导审批 |
| **创建日期** | 2026-07-23 |
| **所属分支** | `b1.6.61-3.2.0` |
| **改动范围** | Cube Core · `schema-compiler` · 半累加（`nonAdditiveDimension`）SQL 生成 |
| **影响级别** | **高** — 调整半累加指标默认计算路径（SQL 形态变更，业务语义保持不变） |
| **相关设计** | [半可加指标技术设计方案](../plans/2026-03-06-semi-additive-measures-design.md)（2026-03） |

---

## 1. 审批结论请求

请审批是否同意将半累加（时点）指标的 **默认 SQL 生成路径**，从：

> `base_data` → `windowed_data`（`MAX/MIN() OVER (PARTITION BY …)`）→ 条件聚合

调整为：

> `base_data` → `partition_bounds`（`GROUP BY` 求边界）→ `matched_data`（JOIN 回明细）→ 条件聚合

并在以下前提下上线：

1. **业务语义与现网一致**（期末/期初取值规则不变）；
2. **`windowChoice: avg` 等少数场景仍走原窗口路径**（功能不回退）；
3. **完成既有 + 新增单元测试**，并在生产样例库做性能对比验收。

---

## 2. 背景与问题

### 2.1 半累加指标是什么

半累加（Semi-Additive / 时点型）指标配置了 `nonAdditiveDimension`，典型场景是银行贷款余额、库存余额等：

- **在机构、产品等维度上可加**；
- **在时间维度上不可简单累加**，需按时间桶取期初（`min`）或期末（`max`）时点再汇总。

Schema 示例：

```javascript
dkye: {
  type: 'sum',
  sql: 'loan_bal',
  nonAdditiveDimension: {
    name: 'etl_date_date',
    windowChoice: 'max', // 期末
  },
}
```

### 2.2 当前实现（改动前）

`BaseQuery.buildSemiAdditiveCTEQuery` 统一生成三层结构：

```text
base_data        — 行级明细 + JOIN（可能无 dateRange，全表扫描）
windowed_data    — 对每一行做 MAX/MIN() OVER (PARTITION BY 时间桶[, windowGroupings])
最终 SELECT      — SUM(CASE WHEN 时间列 = 窗口边界 THEN 原始值 END) GROUP BY 查询维度
```

该方案 **语义正确、跨库语法通用**，但在大数据量下性能差：

| 现象 | 说明 |
|------|------|
| 中间结果大 | `windowed_data` 与 `base_data` 行数同量级（如 ~90 万行） |
| 多次物化 | MySQL 等对 CTE 常物化，EXPLAIN 可见 3 层 DERIVED，各扫 ~90 万行 |
| 窗口代价高 | 全量行上的 `OVER` 比小结果集 `GROUP BY` 贵 |
| 时区转换 | ordering 列若包 `CONVERT_TZ`，进一步加重 CPU |

### 2.3 实测依据（样例环境）

| 场景 | 数据规模 | 耗时 |
|------|----------|------|
| 改动前：窗口 CTE（无 dateRange 全量） | 事实表约百万级，扫描约 90 万行 | **约 35 秒** |
| 等价优化 SQL：`GROUP BY` 边界 + JOIN | 同上 | **约 12 秒** |
| 有 `dateRange`（近一年）+ 索引 | 过滤后子集 | 约 19 秒量级（仍受窗口路径拖累） |

**结论**：瓶颈主要在「对全量明细做窗口函数 + 多层大中间集」，而非单纯缺索引。无 `dateRange` 是合法查询场景，无法靠强制过滤解决，必须优化计算结构。

---

## 3. 改动目标

| 目标 | 说明 |
|------|------|
| **性能** | 在结果语义不变前提下，显著降低半累加查询耗时（尤其无 dateRange / 大表） |
| **语义不变** | 期末/期初边界、measure schema filters、多粒度、windowGroupings、计算指标、排序等行为与现网一致 |
| **全库通用** | 在 `BaseQuery` 生成标准 SQL（`GROUP BY` + `JOIN`），不单独只改 MySQL |
| **可回退** | 不兼容场景自动走原窗口路径；路径选择清晰可测 |

**非目标（本次不做）**：

- Fact-First（事实表先取边界再 JOIN 维表）— 可作为后续增强；
- 预聚合 / Tesseract 原生半累加规划；
- 修改用户侧 cube schema 或业务指标定义；
- 改变 `windowChoice: avg` 的产品语义。

---

## 4. 方案概述（新计算路径）

### 4.1 核心思想

对 `windowChoice ∈ {max, min, first, last}`：

> **「每个时间桶（及 windowGroupings）内的边界时刻」是小结果集**
> → 先用 `GROUP BY` 求出 `MAX/MIN(时间列)`
> → 再 JOIN 回明细行做条件聚合

与窗口函数 `MAX/MIN() OVER (PARTITION BY …)` + `CASE WHEN 时间 = 边界` **数学等价**（并列边界时刻多行全部计入，与现实现一致）。

### 4.2 新 SQL 结构（示意）

```sql
WITH base_data AS (
  -- 行级投影：查询维度、_raw、_for_ordering（裸时间列）
  SELECT ... FROM fact JOIN dims [WHERE 过滤条件]
),
partition_bounds_0 AS (
  -- 行数 ≈ 分区数（按天约数百行），而非全表明细
  SELECT
    <时间桶表达式> AS __sa_p0_0,
    MAX(_for_ordering) AS measure_min_ds   -- 或 MIN，取决于 windowChoice
  FROM base_data
  GROUP BY <时间桶表达式>
),
matched_data AS (
  SELECT base_data.*, partition_bounds_0.measure_min_ds
  FROM base_data
  INNER JOIN partition_bounds_0
    ON (<时间桶> = __sa_p0_0 OR 双方均为 NULL)
)
SELECT
  维度...,
  COALESCE(SUM(
    CASE WHEN _for_ordering = measure_min_ds THEN _raw ELSE NULL END
  ), 0) AS 指标
FROM matched_data
GROUP BY 维度...
```

### 4.3 路径选择

```text
                    buildSemiAdditiveCTEQuery
                              │
              ┌───────────────┴───────────────┐
              │ canUseSemiAdditiveJoinPath?   │
              └───────────────┬───────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │ Yes                                    │ No
         ▼                                        ▼
  buildSemiAdditiveJoinQuery          buildSemiAdditiveWindowQuery
  (partition_bounds + JOIN)           (原 windowed_data + OVER)
```

| 条件 | 路径 |
|------|------|
| 全部半累加 measure 的 `windowChoice` 为 `max` / `min` / `first` / `last` | **JOIN 路径（新默认）** |
| 存在 `windowChoice: avg` | **窗口路径（保留）** |
| 缺少 ordering 列等异常 | **回退窗口路径** |

说明：当前产品里 `first`/`last` 与 `min`/`max` 实现等价（无 `ROW_NUMBER`），故一并纳入 JOIN 路径。

---

## 5. 详细改动清单

### 5.1 代码文件

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `packages/cubejs-schema-compiler/src/adapter/BaseQuery.js` | **核心修改** | 半累加 CTE 生成重构（约 +350 / −100 行量级） |
| `packages/cubejs-schema-compiler/test/unit/semi-additive-measure-filters.test.ts` | 更新断言 | 适配 JOIN 路径（`partition_bounds` / `matched_data`） |
| `packages/cubejs-schema-compiler/test/unit/semi-additive-join-path.test.ts` | **新增** | JOIN 路径、avg 回退、跨库编译用例 |

### 5.2 `BaseQuery.js` 方法级说明

| 方法 | 角色 |
|------|------|
| `buildSemiAdditiveCTEQuery` | 入口：按 `canUseSemiAdditiveJoinPath` 分发 |
| `canUseSemiAdditiveJoinPath` | 判定是否走 JOIN 路径 |
| `buildSemiAdditiveJoinQuery` | **新主路径**：bounds CTE + JOIN + `matched_data` |
| `buildSemiAdditiveWindowQuery` | **原逻辑迁移**：`windowed_data` + `OVER`（fallback） |
| `buildSemiAdditiveOuterSelect` | 外层维度/指标 SELECT 共用 |
| `semiAdditiveBaseColumnAliases` | 从 base_data 投影提取别名 |
| `collectSemiAdditivePartitionClauses` | 统一收集分区表达式（多粒度最细粒、windowGroupings） |
| `buildSemiAdditivePartitionExprs` | 供 bounds `GROUP BY` / JOIN ON 使用 |
| `buildSemiAdditivePartitionBy` | 改为复用 `collectSemiAdditivePartitionClauses`（行为不变） |
| `semiAdditiveBoundaryAggFunc` | `windowChoice` → `MIN`/`MAX` |
| `semiAdditiveOrderingColumnSql` | **Layer B**：ordering 用维度裸 SQL，避免 `CONVERT_TZ` |

### 5.3 刻意未改动的部分

| 项 | 原因 |
|----|------|
| `BaseMeasure.semiAdditiveMeasureSql` | 仍用 `CASE WHEN ordering = *_min_ds THEN _raw`；边界列名兼容 |
| `MysqlQuery` / `OracleQuery` / `DmQuery` 等方言类 | 标准 SQL 即可；方言仅影响 `timeGroupedColumn` 等既有方法 |
| 用户 cube schema / 指标定义 | 无迁移成本 |
| API Gateway / Tesseract | 半累加仍走 JS 生成器 fallback |
| Fact-First | 列为后续可选优化，降低本次风险面 |

---

## 6. 语义等价性说明（审批关键）

以下约束保证「换算法、不换业务含义」：

| 规则 | JOIN 路径如何保证 |
|------|-------------------|
| 期末 = 桶内最大时间点上的值之和 | `MAX(ordering)` + `CASE WHEN ordering = boundary` |
| 期初 = 桶内最小时间点 | `MIN(ordering)` 同理 |
| 同一时刻多行全部计入 | 等值匹配，非 `ROW_NUMBER=1` |
| **measure schema filters**（如不良贷款条件）只过滤取值 | `_raw` 已含 filter；**bounds 在全量 `base_data` 上算边界**，不把 measure filter 放进 `GROUP BY` |
| 多粒度（如 year + month）按最细粒度分区 | 复用原 `collectSemiAdditivePartitionClauses` / `minGranularity` |
| `windowGroupings` | 进入 bounds 的 `GROUP BY`，与原 `PARTITION BY` 一致 |
| 多指标同查（max + min） | 同一 partition 下 bounds CTE 同时输出 MAX、MIN 列 |
| 无 PARTITION 键（无粒度且无 groupings） | `CROSS JOIN` 全局边界，与 `OVER ()` 一致 |
| NULL 分区键 | JOIN 使用 NULL-safe 条件（双方均为 NULL 仍匹配） |
| orderBy / limit / q_0 包装 | 仅作用于外层，与内层路径无关 |

---

## 7. 覆盖的查询场景矩阵

| 场景 | 是否覆盖 | 说明 |
|------|----------|------|
| 单时点 sum + 时间粒度 + 跨 cube 维度 | ✅ JOIN | 贷款余额 × 机构简称典型场景 |
| 有 / 无 `dateRange` | ✅ | 无 dateRange 仍全表扫，但去掉重窗口 |
| measure schema filters | ✅ | 见上表 |
| 计算指标引用多个时点（max/min） | ✅ | 多边界列 |
| 多粒度 timeDimension | ✅ | 最细粒度 bounds |
| windowGroupings | ✅ | 进 GROUP BY |
| count_distinct 时点 | ✅ | 外层仍走原 measureSql |
| multi_stage 同环比（内层时点） | ✅ | 内层 CTE 优化即可 |
| orderBy 时点/计算指标 | ✅ | q_0 不变 |
| `windowChoice: avg` | ✅ 窗口 fallback | 不走 JOIN |
| period_average 混查 | 本分支无此功能 / 不适用 | 其他分支若存在需单独评估 |

---

## 8. 测试与验收

### 8.1 已执行单元测试

| 套件 | 结果 |
|------|------|
| `semi-additive-measure-filters.test.ts` | 通过（已更新断言） |
| `semi-additive-join-path.test.ts`（新增） | 通过 |
| `credit-loan-balance-me6.test.ts` | 通过 |

覆盖点包括：schema filters、计算指标、MySQL/PG/Oracle/DM 排序包装、多粒度、windowGroupings、avg 回退、跨维表 JOIN 编译。

### 8.2 建议上线前验收（业务 / DBA）

1. **语义回归**：同一组时点指标（余额、不良余额、逾期余额等）在有/无 dateRange、日/月/年粒度、带机构维度下，与改动前结果对比（允许浮点误差则按既有规则）。
2. **性能对比**：生产样例库对「无 dateRange 全量」与「近一年」各跑 3 次，对比 P50/P95 与 EXPLAIN（应出现 `partition_bounds`，不应再对全量做 `OVER`）。
3. **回归清单**：指标分析排序、复合指标、同环比派生、多粒度联查。

### 8.3 回滚策略

- **代码回滚**：回退 `BaseQuery.js` 与相关测试即可恢复原窗口路径。
- **运行时降级**：可将 `canUseSemiAdditiveJoinPath` 改为恒 `false`（紧急开关，如需可再加配置项）。

---

## 9. 风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| 边界场景结果与窗口路径不一致 | 高 | 单元测试 + 业务结果对比；路径判定保守；avg 不走 JOIN |
| Oracle/DM 等对 `GROUP BY` 别名限制 | 中 | bounds 使用完整表达式 `GROUP BY`，与现有方言策略一致 |
| CTE 在部分优化器上仍物化 | 中 | 中间集从「全量×窗口」变为「全量 + 极小 bounds」，通常仍明显更快 |
| 并列时刻多行语义被误解为「只取一行」 | 低 | 文档与评审明确：保持等值全计入，与现网一致 |
| 后续 Fact-First 引入额外复杂度 | 低 | 本次不做，单独立项 |

---

## 10. 影响面与发布建议

### 10.1 影响面

- **所有** 配置了 `nonAdditiveDimension` 且 `windowChoice` 为 max/min/first/last 的查询，生成 SQL 形态变更。
- 业务侧 **无需改 schema、无需改 API 入参**。
- 监控/SQL 审计若按 `windowed_data` 关键字告警，需改为识别 `partition_bounds` / `matched_data`。

### 10.2 发布建议

1. 先合入开发/测试环境，完成 §8.2 验收；
2. 选择 1～2 个大事实表时点指标做性能签字；
3. 随 `b1.6.61-3.2.0` 版本发布说明增加「半累加 SQL 生成优化」条目；
4. 保留 1 个迭代观察期，必要时用回滚策略兜底。

---

## 11. 后续可选增强（不在本次审批范围）

| 项 | 说明 |
|----|------|
| **Fact-First** | partition 键全在事实表时，先 bounds 再 JOIN 维表，进一步降 JOIN 成本 |
| **配置开关** | 如 `CUBEJS_SEMI_ADDITIVE_JOIN_PATH=true/false` 便于灰度 |
| **结果等价性集成测试** | 强制 Window vs JOIN 双路径结果集对比 |

---

## 12. 审批意见栏

| 角色 | 意见（同意 / 有条件同意 / 不同意） | 签字 | 日期 |
|------|-----------------------------------|------|------|
| 方案负责人 | | | |
| 技术负责人 | | | |
| 业务 / 指标负责人 | | | |
| 领导审批 | | | |

**有条件同意时需注明条件**（例如：必须完成某库性能对比后再上生产）。

---

## 附录 A：改动前 vs 改动后对比（一页纸）

| 维度 | 改动前 | 改动后（默认） |
|------|--------|----------------|
| 边界计算 | `MAX/MIN() OVER (PARTITION BY …)` | `GROUP BY` 分区键后 `MAX/MIN` |
| 中间 CTE | `windowed_data`（大） | `partition_bounds`（小）+ `matched_data` |
| 最终聚合 | `SUM(CASE WHEN 时间=边界 THEN raw)` | **相同** |
| avg | 窗口 | 仍窗口 |
| schema 变更 | — | 无 |
| 预期性能（大表无 dateRange） | 差（样例 ~35s） | 明显改善（样例等价 SQL ~12s） |

## 附录 B：生成 SQL 关键字对照（便于 Review）

| 改动前 | 改动后 |
|--------|--------|
| `windowed_data AS` | `matched_data AS` |
| `MAX(...) OVER (PARTITION BY ...)` | `partition_bounds_N AS ( ... MAX(...) ... GROUP BY ... )` |
| ordering 可能带 `CONVERT_TZ` | `_for_ordering` 优先裸列 |

---

**文档结束。** 请领导审阅后于 §12 签署意见。
