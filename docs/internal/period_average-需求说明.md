# period_average 原生参数 — 需求说明

> **文档状态**：Draft v1.0  
> **创建日期**：2026-07-13  
> **最后修订**：2026-07-14  
> **关联能力**：Cube Core 数据模型 / Measures  
> **后续文档**：[period_average-设计方案.md](./period_average-设计方案.md) v3.0

---

## 1. 背景与动机

### 1.1 业务场景

用户需要**周期归一化指标**，且业务上对「分母用什么」存在两种常见口径：

| 口径 | 分母含义 | 典型问题 |
|------|---------|---------|
| **有数据口径** | 统计范围内**实际有数据的**日/月/季/年个数 | 「有单子的那些天，平均每天卖多少？」 |
| **自然历口径** | 统计范围内**自然历上应计入的**日/月/季/年个数 | 「这个月按日历天数（或按已过的日历天数），日均是多少？」 |

典型配置如 **「月平均区间的日均」（月日均）**：在**每个月**这个平均区间内，把指标归一化到**日**粒度。

### 1.2 核心设计原则（v1.0）

**指标语义在 measure 定义时即固定，不由查询粒度推断。**

- 配置 **`avg_unit`**（日均/月均等单位）+ **`interval`**（平均区间）后，该 measure 永远是同一种周期平均（例如月日均）。
- **查询粒度**只决定**如何分组展示**，不改变 measure 的语义：
  - 按 **`interval`** 查 → 每个区间一行（整段区间平均）
  - 按 **`avg_unit`** 查 → 每个 avg_unit 一行，在各自 **`interval` 分区内累计**（区间内 MTD 式日均/月均）
- **分母**始终按配置的 `avg_unit` + `interval` + `denominator` 计算，**不**再根据「查询粒度 vs unit」动态切换语义。

> **MVP 说明**：仍**不支持** `week` / `hour` 作为 `avg_unit`、`interval` 或查询 `granularity`。

### 1.3 目标

引入 **`period_average`**：在 `type: number` 的 measure 上引用基础 measure，由引擎计算 **`分子 ÷ 分母`**。分母由 **`avg_unit` + `interval` + `denominator`（口径）+ 查看方式（整区间 / 区间内累计 / 仅 filter 整段）** 共同决定。

---

## 2. 需求范围

### 2.1 In Scope（MVP）

- `period_average` 配置块：**`avg_unit`**、**`interval`**、**`denominator`**、**`time_dimension`**
- 兼容旧字段 **`unit`** 作为 `avg_unit` 别名（`interval` 仍必填）
- **`denominator`** 两档：**`data`（有数据口径）**、**`calendar`（自然历口径）**
- 基础 measure 引用：`sum` / `count` / `avg`
- 查询粒度仅允许 **`interval`** 或 **`avg_unit`**（与配置一致）
- 查询 **不带** `granularity`、仅 **filter 日期范围** 的整段汇总（形态 B）
- **必须** Tesseract SQL Planner

### 2.2 Out of Scope（MVP 不做）

- `week` / `hour` 粒度
- Calendar Cube / Fiscal 历
- Legacy JS Planner 回退
- `count_distinct` / `min` / `max` 等作基础 measure
- period_average 链式引用
- Pre-aggregation 自动加速 period_average measure 本身

---

## 3. 核心概念与术语

| 术语 | 定义 |
|------|------|
| **基础 measure** | `type: sum \| count \| avg`，不含 `period_average` |
| **period_average measure** | `type: number`，`sql` 引用基础 measure + `period_average` 块 |
| **avg_unit** | 归一化目标单位：`day` / `month` / `quarter` / `year`（如「日均」的 `day`） |
| **interval** | 平均区间：`day` / `month` / `quarter` / `year`（如「月平均区间」的 `month`） |
| **denominator（口径）** | `data` = 有数据周期数；`calendar` = 自然历周期数 |
| **分子** | 基础 measure 的聚合：`SUM` / `COUNT` / `AVG`；按日查看时可为区间内**窗口累计** |
| **整区间查看** | 查询 `granularity = interval`：每个 interval 桶一行 |
| **区间内累计查看** | 查询 `granularity = avg_unit` 且 `avg_unit` 细于 `interval`：每个 avg_unit 桶一行，分区内从区间起点累计到当前桶 |
| **形态 B** | 无 `granularity`，仅有日期 filter → 单行整段汇总 |

**粒度序（MVP）**：`day` < `month` < `quarter` < `year`  
**编译约束**：`avg_unit` 必须 **细于或等于** `interval`（通常业务为细于，如 day + month）。

**普通 `type: avg` 与分母（重要）**：

```
AVG(x) = SUM(x) / COUNT(*)
```

`period_average` 在聚合结果之外，再除以**配置的周期分母**（与 `avg` 内隐行数分母无关）。

---

## 4. Measure 模型

### 4.1 Schema 示例

```yaml
measures:
  - name: total_sale_price
    sql: sale_price
    type: sum

  # 月平均区间的日均（月日均）— 自然历
  - name: period_daily_avg_revenue_calendar
    sql: "{total_sale_price}"
    type: number
    period_average:
      avg_unit: day
      interval: month
      denominator: calendar
      time_dimension: created_at

  # 月日均 — 有数据口径
  - name: period_daily_avg_revenue_data
    sql: "{total_sale_price}"
    type: number
    period_average:
      avg_unit: day
      interval: month
      denominator: data
      time_dimension: created_at

  # 跨 filter 的月均（形态 B）
  - name: period_monthly_avg_revenue
    sql: "{total_sale_price}"
    type: number
    period_average:
      avg_unit: month
      interval: month
      denominator: calendar
      time_dimension: created_at

  # 年平均区间的月均（按年看整年；按月看年内累计月均）
  - name: period_monthly_in_year_avg
    sql: "{total_sale_price}"
    type: number
    period_average:
      avg_unit: month
      interval: year
      denominator: calendar
      time_dimension: created_at
```

### 4.2 固定规则

| 规则 | 说明 |
|------|------|
| `type` | **必须为 `number`** |
| `sql` | **必须**仅引用一个基础 measure |
| `avg_unit` + `interval` | **必填**（`unit` 可代替 `avg_unit`） |
| `denominator` | **必填**：`data` 或 `calendar` |
| `time_dimension` | **必填** |
| 最终公式 | `{分子} / NULLIF(分母, 0)` |

### 4.3 时点型（半累加）基础 measure

当 `period_average` 的 `sql` 引用的基础 measure 配置了 **`nonAdditiveDimension`**（期初/期末时点型指标）时：

| 场景 | 行为 |
|------|------|
| **仅查询 period_average** | 不建半累加 CTE（`base_data` / `windowed_data`）；分子对原始列做普通 **`SUM` / `COUNT` / `AVG`**，再除以周期分母 |
| **period_average + 时点 measure 同查** | 被直接选中的时点 measure 仍走半累加；**period_average 分子展开**仍按普通聚合，**不**取期初/期末窗口值 |
| **错误行为（须避免）** | 把 PA 分子当作期末时点（如仅取全局 `MAX(stat_dt)` 对应余额再 ÷ 分母） |

**示例**：2026-04-01~04-03 共 7 行 `balance_snapshot` 合计 7250，月日均 calendar 分母 30 → **7250 ÷ 30 ≈ 241.67**；若误用期末时点值 1020 → **1020 ÷ 30 = 34**（错误）。

编译期会从 `sql` 推断并写入 `baseMeasure` / `baseAggType`，供 Tesseract 渲染分子时使用。

---

## 5. 业务场景样例

### 5.1 月日均 — 按 interval（月）查看

**配置**：`avg_unit: day`，`interval: month`

**查询**：`granularity: month`，filter 含 **2025 年 6 月**。

| 口径 | 分子 | 分母 |
|------|------|------|
| `calendar` | `SUM(6 月)` | 6 月自然日数 = **30** |
| `data` | 同上 | 6 月有数据的 distinct 日数（如 6/11–12 无数据 → **28**） |

---

### 5.2 月日均 — 按 avg_unit（日）查看（区间内累计）

**配置**：`avg_unit: day`，`interval: month`（同上，语义不变）

**查询**：`granularity: day`，filter 含某月。

每个**日**一行；在**当月分区内**从月初累计到该行日期：

| 日期 | 分子（calendar/data 相同累计和） | 分母 calendar | 分母 data |
|------|----------------------------------|---------------|-----------|
| 1 月 1 日 | 当日 SUM | **1**（月初→当日自然日数） | **1**（有数据日数） |
| 1 月 2 日 | 1/1 + 1/2 累计 SUM | **2** | 有数据日累计数 |
| 1 月 3 日 | 1/1 + 1/2 + 1/3 | **3** | 有数据日累计数 |

- **calendar**：分母 = 区间起点（月初）到**当前行日期**的**自然日数**（含当日）。
- **data**：分母 = 区间起点到**当前行日期**内**有数据的 distinct 日**数（按日分组时可用窗口行计数）。

---

### 5.3 月均 — avg_unit = interval = month

**配置**：`avg_unit: month`，`interval: month`

**按 month 查本月**：分母 **1**（等价于当月 SUM）。

**形态 B**（无 granularity，filter 2025-04-01 ~ 2025-06-30）：

| 口径 | 分子 | 分母 |
|------|------|------|
| `calendar` | `SUM(4–6 月)` | **3** 个自然月 |
| `data` | 同上 | 有数据的 distinct **月**数（5 月无数据 → **2**） |

---

### 5.4 年平均区间的月均

**配置**：`avg_unit: month`，`interval: year`

| 查询粒度 | 行为 |
|---------|------|
| `year` | 每年一行：分子 = 当年 SUM，分母 = 当年自然月数 = **12** |
| `month` | 每月一行：分子 = 年初至当月累计 SUM，分母 = 年初至当月自然月数 / 有数据月数 |

**注意**：月日均（`interval: month`）**不能**按 `year` 查询 — 应报错。

---

## 6. Schema API 与编译约束

```yaml
period_average:
  avg_unit: day | month | quarter | year   # 必填（或 unit 别名）
  interval: day | month | quarter | year     # 必填
  denominator: data | calendar               # 必填
  time_dimension: <string>                   # 必填
```

| 约束 | 行为 |
|------|------|
| 缺 `interval` / `avg_unit` / `denominator` / `time_dimension` | 编译报错 |
| `avg_unit` 细于 `interval` 不成立且二者不等 | 编译报错 |
| 查询 `granularity` ∉ {`interval`, `avg_unit`} | 查询报错 |
| `granularity` 为 `week` / `hour` | 查询报错 |
| 形态 B 无日期 filter | 查询报错 |

---

## 7. 分母与分子规则总表

### 7.1 查看方式判定

| 条件 | 查看方式 |
|------|---------|
| 无 `granularity`，有日期 filter | **形态 B**（整段） |
| `granularity = interval` | **整区间** |
| `granularity = avg_unit` 且 `avg_unit < interval` | **区间内累计** |
| `granularity = avg_unit = interval` | **整区间**（分母 1） |

### 7.2 整区间查看（`granularity = interval`）

**分母** = 该 interval 桶内按 `avg_unit` 计数（calendar / data）。

**分子** = 桶内基础 measure 的 `{AGG}`。

### 7.3 区间内累计查看（`granularity = avg_unit`）

**分子** = `SUM({AGG}) OVER (PARTITION BY interval ORDER BY avg_unit ROWS UNBOUNDED PRECEDING)`  
**分母 calendar** = 从 interval 起点到当前 avg_unit 桶的自然 `avg_unit` 数  
**分母 data** = 从 interval 起点到当前桶的有数据 `avg_unit` 数（窗口计数）

### 7.4 形态 B

**分母** = filter 闭区间内按 `avg_unit` 的 calendar / data 计数。
**分子** = 整个 filter 范围内 `{AGG}`，**单行**（无时间 GROUP BY）。

---

## 8. 验收场景

场景按 **配置（avg_unit / interval）× 口径 × 查看方式** 组合，确保每种组合都不遗漏。

| # | 配置（avg_unit / interval） | denominator | 查看 | granularity | filter | 期望 |
|---|----------------------------|-------------|------|-------------|--------|------|
| 1 | day / month | calendar | 整区间 | month | 2025-06 | SUM÷**30** |
| 2 | day / month | data | 整区间 | month | 2025-06（6/11–12 无数据） | SUM÷**28** |
| 3 | day / month | calendar | 累计 | day | 2025-06 | 6/1→÷1；6/15→累计÷15；6/30→÷30 |
| 4 | day / month | data | 累计 | day | 2025-06（6/11–12 无数据） | 6/12→6/10+6/12 累计÷11（跳过无数据日） |
| 5 | day / month | calendar | 形态 B | — | 2025-04-01~06-30 | 1 行；SUM÷**91**（4+5+6 月天数） |
| 6 | day / month | data | 形态 B | — | 2025-04-01~06-30（5 月无数据） | 1 行；SUM÷有数据日数 |
| 7 | month / month | calendar | 整区间 | month | 2025-06 | SUM÷**1** |
| 8 | month / month | data | 整区间 | month | 2025-06 | SUM÷**1** |
| 9 | month / month | calendar | 形态 B | — | 2025-04-01~06-30 | 1 行；SUM÷**3** |
| 10 | month / month | data | 形态 B | — | 2025-04-01~06-30（5 月无数据） | 1 行；SUM÷**2** |
| 11 | month / year | calendar | 整区间 | year | 2024 | SUM÷**12** |
| 12 | month / year | data | 整区间 | year | 2024 | SUM÷有数据的月数 |
| 13 | month / year | calendar | 累计 | month | 2024 | 1 月→÷1；6 月→累计÷6；12 月→÷12 |
| 14 | month / year | data | 累计 | month | 2024（3 月无数据） | 有数据的月累计数 |
| 15 | month / year | calendar | 形态 B | — | 2024-01-01~2024-12-31 | 1 行；SUM÷**12** |
| 16 | day / month | calendar | 整区间 | month | 2025-06 | AVG÷分母 ≠ SUM÷分母（avg 基础 measure） |
| 17 | day / month | — | — | **week** | 2025-06 | **报错**（不支持 week） |
| 18 | day / month | — | — | **year** | 2025 | **报错**（粒度与配置不符） |
| 19 | month / month | — | — | **day** | 2025-06 | **报错**（粒度与配置不符） |

**场景覆盖说明**：

- **day/month 配置**（最典型「月日均」）：三种查看方式 × 两口径 = #1–#6，全覆盖。
- **month/month 配置**（avg_unit = interval）：整区间分母恒为 1；形态 B 跨区间 = #7–#10。
- **month/year 配置**（跨年月均）：三种查看方式 × 两口径 = #11–#15，全覆盖（补充了原缺失的 data 口径整区间/累计/形态 B）。
- **avg 基础 measure**：#16。
- **报错场景**：#17–#19（week / 粒度不匹配）。

---

## 9. 已确认决策（v1.0）

| 项 | 结论 |
|----|------|
| 语义锚点 | **`avg_unit` + `interval` 在 measure 定义时固定** |
| 查询粒度 | 仅 **`interval`** 或 **`avg_unit`** |
| 分母口径 | **`data`** / **`calendar`** |
| 按日查月日均 | **区间内累计**（非独立日平均） |
| Tesseract | **必须** |

---

## 10. 文档修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.1–v0.5 | 2026-07-13 | 单 `unit` + 查询粒度推断分母 |
| **v1.0** | 2026-07-14 | **`avg_unit` + `interval` 固定语义**；整区间 vs 区间内累计；查询粒度仅作分组 |
