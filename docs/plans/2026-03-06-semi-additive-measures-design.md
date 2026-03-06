# Cube 半可加指标（Semi-Additive Measures）技术设计方案

## 📋 文档信息

| 项目 | 内容 |
|------|------|
| **文档版本** | v1.0 |
| **创建日期** | 2026-03-04 |
| **参考标准** | dbt Metricflow Non-Additive Dimensions |
| **目标功能** | 在 Cube 中原生支持半可加指标（如银行余额、月末库存等） |

---

## 1. 背景与问题分析

### 1.1 什么是半可加指标

**半可加指标（Semi-Additive Measures）** 是指只能在某些维度上进行聚合，而不能在所有维度上简单累加的指标。

**典型场景：**

| 指标类型 | 时间维度 | 其他维度 | 示例 |
|---------|---------|---------|------|
| **全可加** | ✅ 可累加 | ✅ 可累加 | 销售额、订单数 |
| **半可加** | ❌ 不可累加 | ✅ 可累加 | 银行余额、月末库存 |
| **不可加** | ❌ 不可累加 | ❌ 不可累加 | 比率、百分比 |

### 1.2 具体问题示例

```sql
-- 错误示例：直接累加余额
SELECT
  DATE_TRUNC('month', date) AS month,
  SUM(balance) AS total_balance  -- ❌ 错误：将每天的余额相加
FROM account_snapshots
GROUP BY 1;

-- 正确做法：取月末余额
SELECT
  DATE_TRUNC('month', date) AS month,
  account_id,
  -- ✅ 取该月最后一个时间点的余额
  (ARRAY_AGG(balance ORDER BY date DESC))[1] AS month_end_balance
FROM account_snapshots
GROUP BY 1, 2;
```

### 1.3 当前 Cube 的局限性

在当前的 Cube 实现中（`packages/cubejs-schema-compiler/src/adapter/BaseMeasure.ts`）：

```typescript
// 当前支持的 measure 类型
export type MeasureDefinition = {
  type: string;  // 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct'
  sql(): string;
  rollingWindow?: any;  // 仅支持滚动窗口，不支持半可加
  // ...
};
```

**缺失的功能：**
- ❌ 无法定义非可加维度
- ❌ 无法指定窗口函数（如月末取 max）
- ❌ 无法在特定维度上禁用累加

---

## 2. 技术设计方案

### 2.1 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Cube Schema Layer                        │
│  cube('AccountBalances', {                                  │
│    measures: {                                              │
│      monthEndBalance: {                                     │
│        type: 'sum',                                         │
│        nonAdditiveDimension: {  ← 新增配置                  │
│          name: 'date',                                      │
│          windowChoice: 'max'                                │
│        }                                                    │
│      }                                                      │
│    }                                                        │
│  })                                                         │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              Schema Compiler & Validator                    │
│  - 解析 nonAdditiveDimension 配置                           │
│  - 验证配置有效性                                            │
│  - 生成 MeasureDefinition 扩展类型                          │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   BaseMeasure Adapter                       │
│  - 新增 isSemiAdditive() 方法                               │
│  - 新增 nonAdditiveConfig 属性                              │
│  - 扩展 measureSql() 生成逻辑                               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                  SQL Generation Layer                      │
│  - 生成窗口函数 SQL (MAX() OVER, MIN() OVER)                │
│  - 或生成子查询 + DISTINCT                                   │
│  - 处理跨时间粒度的查询                                      │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心 API 设计

#### 2.2.1 Schema 定义 API

```javascript
cube('AccountBalances', {
  sql: 'account_snapshots',

  dimensions: {
    date: {
      sql: 'snapshot_date',
      type: 'time'
    },
    accountId: {
      sql: 'account_id',
      type: 'number'
    },
    accountType: {
      sql: 'account_type',
      type: 'string'
    }
  },

  measures: {
    // ===== 半可加指标 =====

    // 场景1: 月末余额（取月末值）
    monthEndBalance: {
      sql: 'balance',
      type: 'sum',
      nonAdditiveDimension: {
        name: 'date',           // 指定非可加的时间维度
        windowChoice: 'max'     // 取窗口内最大值（月末）
      }
    },

    // 场景2: 月初余额（取月初值）
    monthStartBalance: {
      sql: 'balance',
      type: 'sum',
      nonAdditiveDimension: {
        name: 'date',
        windowChoice: 'min'     // 取窗口内最小值（月初）
      }
    },

    // 场景3: 分组后的月末余额
    accountMonthEndBalance: {
      sql: 'balance',
      type: 'sum',
      nonAdditiveDimension: {
        name: 'date',
        windowChoice: 'max',
        windowGroupings: [      // 在这些维度上分组后应用窗口
          'accountId',
          'accountType'
        ]
      }
    },

    // 场景4: 特定时间点的值（如最后一个值）
    latestBalance: {
      sql: 'balance',
      type: 'sum',
      nonAdditiveDimension: {
        name: 'date',
        windowChoice: 'max',
        useLastValue: true      // 使用 LAST_VALUE 窗口函数
      }
    },

    // ===== 全可加指标（正常定义）=====
    transactionCount: {
      sql: 'transaction_count',
      type: 'sum'
    }
  }
});
```

#### 2.2.2 TypeScript 类型定义

参考 dbt Metricflow 的设计，关键点是 **`window_groupings` 决定了在应用窗口函数之前的分组粒度**。

```typescript
/**
 * 文件: packages/cubejs-schema-compiler/src/compiler/CubeEvaluator.ts
 */

/**
 * 非可加维度配置（参考 dbt Metricflow 设计）
 */
export type NonAdditiveDimensionConfig = {
  /**
   * 非可加维度的名称（通常是时间维度）
   *
   * 示例: 'subscriptionDate'
   */
  name: string;

  /**
   * 窗口函数选择器
   * - 'max': 取窗口内最大值（月末余额、期末MRR）
   * - 'min': 取窗口内最小值（月初余额、期初MRR）
   * - 'avg': 取窗口内平均值
   * - 'first': 取窗口内第一个值
   * - 'last': 取窗口内最后一个值
   *
   * 示例: 'max' 表示取月末值
   */
  windowChoice: 'max' | 'min' | 'avg' | 'first' | 'last';

  /**
   * 分组维度列表（可选但重要）
   *
   * 决定在应用窗口函数之前的分组粒度
   *
   * 工作原理：
   * - 不指定：在时间粒度（如月份）内取全局最大值
   * - 指定 [user_id]：在每个 (月份, 用户) 分区内取最大值
   * - 指定 [user_id, plan_id]：在每个 (月份, 用户, 计划) 分区内取最大值
   *
   * 示例场景：
   * - 查询 "每个用户的月末MRR"：windowGroupings: ['userId']
   * - 查询 "所有用户的月末总MRR"：不指定 windowGroupings
   *
   * 实现细节：
   * 这些维度会被添加到窗口函数的 PARTITION BY 子句中
   *
   * SQL 示例：
   * - 有 windowGroupings: ['userId']:
   *   MAX(balance) OVER (PARTITION BY DATE_TRUNC('month', date), user_id)
   * - 无 windowGroupings:
   *   MAX(balance) OVER (PARTITION BY DATE_TRUNC('month', date))
   */
  windowGroupings?: string[];

  /**
   * 可选：是否使用 DISTINCT 去重
   * 某些场景下需要先去重再聚合
   *
   * 示例: 当一天内有重复快照时
   */
  distinct?: boolean;

  /**
   * 可选：自定义窗口范围
   * 默认为整个分区（UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING）
   */
  windowFrame?: {
    start?: string;
    end?: string;
  };
};

/**
 * 扩展的 MeasureDefinition 类型
 */
export type MeasureDefinition = {
  type: string;
  sql(): string;
  ownedByCube: boolean;

  // 现有属性
  rollingWindow?: any;
  filters?: any;
  primaryKey?: true;
  drillFilters?: any;
  multiStage?: boolean;

  // ===== 新增：半可加配置 =====
  /**
   * 非可加维度配置
   * 当配置此项时，该 measure 将被视为半可加指标
   */
  nonAdditiveDimension?: NonAdditiveDimensionConfig;

  // ... 其他现有属性
};
```

#### 2.2.3 window_groupings 详解

参考 dbt Metricflow 的订阅收入（MRR）示例，`window_groupings` 决定了在应用窗口函数之前的分组粒度。

**业务场景示例：**

```javascript
cube('Subscriptions', {
  sql: 'subscription_snapshots',

  dimensions: {
    subscriptionDate: {
      sql: 'date',
      type: 'time'
    },
    userId: {
      sql: 'user_id',
      type: 'number'
    },
    planId: {
      sql: 'plan_id',
      type: 'string'
    }
  },

  measures: {
    // 示例 1: 简单的月末 MRR（不分组）
    monthEndMRR: {
      sql: 'subscription_value',
      type: 'sum',
      nonAdditiveDimension: {
        name: 'subscriptionDate',
        windowChoice: 'max'
        // 不使用 window_groupings
        // 查询: "所有用户的月末总MRR"
      }
    },

    // 示例 2: 按用户分组的月末 MRR
    userMonthEndMRR: {
      sql: 'subscription_value',
      type: 'sum',
      nonAdditiveDimension: {
        name: 'subscriptionDate',
        windowChoice: 'max',
        windowGroupings: ['userId']  // 按每个用户分别计算
        // 查询: "每个用户的月末MRR"
      }
    },

    // 示例 3: 按用户和计划分组的月末 MRR
    userPlanMonthEndMRR: {
      sql: 'subscription_value',
      type: 'sum',
      nonAdditiveDimension: {
        name: 'subscriptionDate',
        windowChoice: 'max',
        windowGroupings: ['userId', 'planId']  // 多维度分组
        // 查询: "每个用户每个计划的月末MRR"
      }
    }
  }
});
```

**window_groupings 作用对比表：**

| 配置 | 查询场景 | PARTITION BY 子句 | 业务含义 |
|------|---------|-------------------|---------|
| 不指定 | 所有用户的月末总MRR | `DATE_TRUNC('month', date)` | 全局聚合 |
| `['userId']` | 每个用户的月末MRR | `DATE_TRUNC('month', date), user_id` | 按用户分组 |
| `['userId', 'planId']` | 每个用户每个计划的月末MRR | `DATE_TRUNC('month', date), user_id, plan_id` | 多维度分组 |
| `['region', 'branchId']` | 每个区域每个分支的月末余额 | `DATE_TRUNC('month', date), region, branch_id` | 地理分组 |

**SQL 生成对比：**

```sql
-- 不使用 windowGroupings：全局月末 MRR
WITH semi_additive_preprocess AS (
  SELECT
    DATE_TRUNC('month', subscription_date) as month,
    subscription_value,
    MAX(subscription_date) OVER (
      PARTITION BY DATE_TRUNC('month', subscription_date)
    ) as max_date_in_month
  FROM subscription_snapshots
)
SELECT
  month,
  SUM(subscription_value) FILTER (
    WHERE subscription_date = max_date_in_month
  ) as month_end_mrr
FROM semi_additive_preprocess
GROUP BY month;
-- 结果: 单行，包含所有用户的月末总MRR

-- 使用 windowGroupings: ['userId']：按用户分组的月末 MRR
WITH semi_additive_preprocess AS (
  SELECT
    user_id,
    DATE_TRUNC('month', subscription_date) as month,
    subscription_value,
    MAX(subscription_date) OVER (
      PARTITION BY user_id, DATE_TRUNC('month', subscription_date)
    ) as max_date_in_month_for_user
  FROM subscription_snapshots
)
SELECT
  user_id,
  month,
  SUM(subscription_value) FILTER (
    WHERE subscription_date = max_date_in_month_for_user
  ) as user_month_end_mrr
FROM semi_additive_preprocess
GROUP BY user_id, month;
-- 结果: 多行，每个用户一行
```

---

## 3. 代码实现方案

### 3.1 修改 BaseMeasure 类

**文件:** `packages/cubejs-schema-compiler/src/adapter/BaseMeasure.ts`

```typescript
export class BaseMeasure {
  // ... 现有属性 ...

  /**
   * 新增：非可加维度配置
   */
  public readonly nonAdditiveConfig: NonAdditiveDimensionConfig | null = null;

  public constructor(
    protected readonly query: BaseQuery,
    public readonly measure: any
  ) {
    // ... 现有构造函数代码 ...

    // 新增：提取非可加配置
    const definition = this.measureDefinition();
    if (definition.nonAdditiveDimension) {
      this.nonAdditiveConfig = definition.nonAdditiveDimension;
    }
  }

  /**
   * 新增：判断是否为半可加指标
   */
  public isSemiAdditive(): boolean {
    return !!this.nonAdditiveConfig;
  }

  /**
   * 新增：判断指标是否可加
   *
   * 规则：
   * - 半可加指标：在非可加维度上不可加
   * - 全可加指标：完全可加
   * - 不可加指标：完全不可加
   */
  public isAdditive(): boolean {
    if (this.expression) {
      return false;
    }

    // 如果配置了非可加维度，则不是完全可加的
    if (this.isSemiAdditive()) {
      return false;
    }

    const definition = this.measureDefinition();
    if (definition.multiStage) {
      return false;
    }

    return definition.type === 'sum' ||
           definition.type === 'count' ||
           definition.type === 'countDistinctApprox' ||
           definition.type === 'min' ||
           definition.type === 'max';
  }

  /**
   * 修改：扩展 SQL 生成逻辑
   *
   * 生成策略：
   * 1. 如果是半可加指标，生成带窗口函数的 SQL
   * 2. 如果是普通指标，使用原有逻辑
   */
  public measureSql(): string {
    // 处理表达式类型的 measure
    if (this.expression) {
      return this.convertTzForRawTimeDimensionIfNeeded(
        () => this.query.evaluateSymbolSql(
          this.expressionCubeName,
          this.expressionName,
          this.definition(),
          'measure'
        )
      );
    }

    // 新增：处理半可加指标
    if (this.isSemiAdditive()) {
      return this.semiAdditiveMeasureSql();
    }

    // 原有逻辑：普通指标
    return this.query.measureSql(this);
  }

  /**
   * 新增：生成半可加指标的 SQL
   *
   * 实现策略：
   * 策略 A: 使用窗口函数（推荐）
   * 策略 B: 使用子查询 + DISTINCT
   */
  private semiAdditiveMeasureSql(): string {
    const config = this.nonAdditiveConfig!;
    const baseSql = this.measureDefinition().sql();
    const alias = this.unescapedAliasName();

    // 根据窗口选择器生成不同的 SQL
    switch (config.windowChoice) {
      case 'max':
        return this.generateWindowFunctionSql(baseSql, config, 'MAX');
      case 'min':
        return this.generateWindowFunctionSql(baseSql, config, 'MIN');
      case 'avg':
        return this.generateWindowFunctionSql(baseSql, config, 'AVG');
      case 'last':
        return this.generateLastValueSql(baseSql, config);
      case 'first':
        return this.generateFirstValueSql(baseSql, config);
      default:
        throw new UserError(
          `Unsupported windowChoice for semi-additive measure: ${config.windowChoice}`
        );
    }
  }

  /**
   * 生成窗口函数 SQL
   *
   * 示例输出：
   * SUM(balance) FILTER (WHERE date = MAX(date) OVER (PARTITION BY account_id, DATE_TRUNC('month', date)))
   */
  private generateWindowFunctionSql(
    baseSql: string,
    config: NonAdditiveDimensionConfig,
    aggregateFunc: string
  ): string {
    const dimensionName = config.name;
    const windowGroupings = config.windowGroupings || [];

    // 构建 PARTITION BY 子句
    const partitionByClauses: string[] = [];

    // 添加时间粒度分区（如月份）
    const timeGrain = this.query.getTimeDimensionGranularity(dimensionName);
    if (timeGrain) {
      partitionByClauses.push(
        `DATE_TRUNC('${timeGrain}', ${this.query.dimensionSql(dimensionName)})`
      );
    }

    // 添加自定义分组维度
    windowGroupings.forEach(grouping => {
      partitionByClauses.push(this.query.dimensionSql(grouping));
    });

    const partitionBy = partitionByClauses.length > 0
      ? `PARTITION BY ${partitionByClauses.join(', ')}`
      : '';

    // 生成窗口函数
    const windowSql = `${aggregateFunc}(${baseSql}) OVER (${partitionBy})`;

    // 生成条件聚合
    return `${this.measureDefinition().type.toUpperCase()}(${baseSql}) FILTER (WHERE ${dimensionName} = ${windowSql})`;
  }

  /**
   * 生成 LAST_VALUE 窗口函数 SQL
   */
  private generateLastValueSql(baseSql: string, config: NonAdditiveDimensionConfig): string {
    const partitionBy = this.buildPartitionBy(config);

    return `LAST_VALUE(${baseSql}) OVER (${partitionBy} ORDER BY ${config.name} DESC)`;
  }

  /**
   * 生成 FIRST_VALUE 窗口函数 SQL
   */
  private generateFirstValueSql(baseSql: string, config: NonAdditiveDimensionConfig): string {
    const partitionBy = this.buildPartitionBy(config);

    return `FIRST_VALUE(${baseSql}) OVER (${partitionBy} ORDER BY ${config.name} ASC)`;
  }

  /**
   * 构建 PARTITION BY 子句
   */
  private buildPartitionBy(config: NonAdditiveDimensionConfig): string {
    const clauses: string[] = [];

    const timeGrain = this.query.getTimeDimensionGranularity(config.name);
    if (timeGrain) {
      clauses.push(`DATE_TRUNC('${timeGrain}', ${config.name})`);
    }

    if (config.windowGroupings) {
      clauses.push(...config.windowGroupings);
    }

    return clauses.length > 0 ? `PARTITION BY ${clauses.join(', ')}` : '';
  }

  // ... 其他现有方法 ...
}
```

### 3.2 扩展 CubeValidator

**文件:** `packages/cubejs-schema-compiler/src/compiler/CubeValidator.ts`

```typescript
export class CubeValidator {
  // ... 现有代码 ...

  /**
   * 新增：验证半可加配置
   */
  public validateNonAdditiveDimension(
    cubeName: string,
    measureName: string,
    config: NonAdditiveDimensionConfig
  ): void {
    const cube = this.cubeEvaluator.cubeFromPath(cubeName);

    // 1. 验证指定的维度是否存在
    if (!cube.dimensions[config.name]) {
      throw new UserError(
        `Non-additive dimension '${config.name}' not found in cube '${cubeName}'`
      );
    }

    // 2. 验证维度类型（建议是时间维度）
    const dimension = cube.dimensions[config.name];
    if (dimension.type !== 'time') {
      console.warn(
        `Warning: Non-additive dimension '${config.name}' in measure '${measureName}' ` +
        `is not a time dimension. This is unusual but not invalid.`
      );
    }

    // 3. 验证 windowChoice 有效性
    const validChoices = ['max', 'min', 'avg', 'first', 'last'];
    if (!validChoices.includes(config.windowChoice)) {
      throw new UserError(
        `Invalid windowChoice '${config.windowChoice}' for non-additive dimension. ` +
        `Must be one of: ${validChoices.join(', ')}`
      );
    }

    // 4. 验证 windowGroupings 中的维度是否存在
    if (config.windowGroupings) {
      for (const grouping of config.windowGroupings) {
        const groupingPath = this.cubeEvaluator.parsePath('dimensions', grouping);
        if (!groupingPath) {
          throw new UserError(
            `Window grouping dimension '${grouping}' not found in cube '${cubeName}'`
          );
        }
      }
    }

    // 5. 验证 measure 类型兼容性
    const measure = cube.measures[measureName];
    const compatibleTypes = ['sum', 'avg', 'min', 'max'];
    if (!compatibleTypes.includes(measure.type)) {
      throw new UserError(
        `Non-additive dimension is not compatible with measure type '${measure.type}'. ` +
        `Compatible types: ${compatibleTypes.join(', ')}`
      );
    }
  }
}
```

### 3.3 修改 SQL 查询生成器

**文件:** `packages/cubejs-schema-compiler/src/adapter/QueryBuilder.ts`

```typescript
export class QueryBuilder {
  // ... 现有代码 ...

  /**
   * 修改：扩展 SELECT 子句生成逻辑
   */
  public buildSelectClause(): string {
    const measures = this.getMeasures();
    const regularMeasures = measures.filter(m => !m.isSemiAdditive());
    const semiAdditiveMeasures = measures.filter(m => m.isSemiAdditive());

    // 如果有半可加指标，需要使用子查询或 CTE
    if (semiAdditiveMeasures.length > 0) {
      return this.buildSemiAdditiveSelectClause(regularMeasures, semiAdditiveMeasures);
    }

    // 原有逻辑
    return this.buildRegularSelectClause(measures);
  }

  /**
   * 新增：构建包含半可加指标的查询
   *
   * 策略：使用 CTE（Common Table Expression）预处理半可加指标
   *
   * 示例 SQL 结构：
   * WITH semi_additive_cte AS (
   *   SELECT
   *     account_id,
   *     DATE_TRUNC('month', date) as month,
   *     MAX(balance) OVER (PARTITION BY account_id, DATE_TRUNC('month', date)) as max_balance_per_month
   *   FROM account_snapshots
   * )
   * SELECT
   *   account_id,
   *   month,
   *   SUM(balance) FILTER (WHERE balance = max_balance_per_month) as month_end_balance
   * FROM semi_additive_cte
   * GROUP BY 1, 2
   */
  private buildSemiAdditiveSelectClause(
    regularMeasures: BaseMeasure[],
    semiAdditiveMeasures: BaseMeasure[]
  ): string {
    const cteName = 'semi_additive_preprocess';
    const dimensionRefs = this.getDimensionReferences();
    const timeDimensionRefs = this.getTimeDimensionReferences();

    // 生成 CTE
    const cteSelectColumns = [
      ...dimensionRefs.map(d => this.dimensionSql(d)),
      ...timeDimensionRefs.map(t => this.timeDimensionSql(t)),
      ...semiAdditiveMeasures.map(m => this.buildSemiAdditiveWindowSql(m))
    ];

    const cteSql = `
      WITH ${cteName} AS (
        SELECT
          ${cteSelectColumns.join(',\n          ')}
        FROM ${this.fromSql()}
        ${this.whereSql('WHERE') ? '\n' + this.whereSql('WHERE') : ''}
      )
    `;

    // 生成主查询
    const mainSelectColumns = [
      ...dimensionRefs.map(d => `${this.dimensionSql(d)} as ${d}`),
      ...timeDimensionRefs.map(t => `${this.timeDimensionSql(t)} as ${t}`),
      ...regularMeasures.map(m => m.selectColumns()[0]),
      ...semiAdditiveMeasures.map(m => this.buildSemiAdditiveAggregationSql(m, cteName))
    ];

    const groupByColumns = [
      ...dimensionRefs,
      ...timeDimensionRefs.map(t => t.split('.')[1])
    ];

    return `
      ${cteSql}
      SELECT
        ${mainSelectColumns.join(',\n        ')}
      FROM ${cteName}
      GROUP BY ${groupByColumns.join(', ')}
    `;
  }

  /**
   * 构建半可加指标的窗口函数 SQL（用于 CTE）
   */
  private buildSemiAdditiveWindowSql(measure: BaseMeasure): string {
    const config = measure.nonAdditiveConfig!;
    const baseSql = measure.sqlDefinition();
    const alias = `${measure.unescapedAliasName()}_window`;

    const partitionBy = this.buildPartitionByForMeasure(config);

    return `${config.windowChoice.toUpperCase()}(${baseSql}) OVER (${partitionBy}) as ${alias}`;
  }

  /**
   * 构建半可加指标的聚合 SQL（用于主查询）
   */
  private buildSemiAdditiveAggregationSql(measure: BaseMeasure, cteName: string): string {
    const config = measure.nonAdditiveConfig!;
    const baseSql = measure.sqlDefinition();
    const windowAlias = `${measure.unescapedAliasName()}_window`;
    const measureAlias = measure.aliasName();

    return `${measure.measureDefinition().type.toUpperCase()}(${baseSql}) FILTER (WHERE ${baseSql} = ${cteName}.${windowAlias}) as ${measureAlias}`;
  }

  private buildPartitionByForMeasure(config: NonAdditiveDimensionConfig): string {
    const clauses: string[] = [];

    // 添加时间维度分区
    const timeDimension = this.timeDimensionSql(config.name);
    const granularity = this.getTimeDimensionGranularity(config.name);
    if (granularity) {
      clauses.push(`DATE_TRUNC('${granularity}', ${timeDimension})`);
    } else {
      clauses.push(timeDimension);
    }

    // 添加自定义分组
    if (config.windowGroupings) {
      config.windowGroupings.forEach(grouping => {
        clauses.push(this.dimensionSql(grouping));
      });
    }

    return `PARTITION BY ${clauses.join(', ')}`;
  }
}
```

---

## 4. SQL 生成示例

### 4.1 简单场景：月末余额

**Schema:**
```javascript
cube('AccountBalances', {
  measures: {
    monthEndBalance: {
      sql: 'balance',
      type: 'sum',
      nonAdditiveDimension: {
        name: 'date',
        windowChoice: 'max'
      }
    }
  }
});
```

**生成的 SQL:**
```sql
WITH semi_additive_preprocess AS (
  SELECT
    account_id,
    DATE_TRUNC('month', date) as month,
    balance,
    MAX(balance) OVER (
      PARTITION BY account_id, DATE_TRUNC('month', date)
    ) as month_end_balance_window
  FROM account_snapshots
)
SELECT
  account_id,
  month,
  SUM(balance) FILTER (
    WHERE balance = month_end_balance_window
  ) as month_end_balance
FROM semi_additive_preprocess
GROUP BY 1, 2;
```

### 4.2 复杂场景：多维度分组的月末余额

**Schema:**
```javascript
cube('AccountBalances', {
  measures: {
    accountMonthEndBalance: {
      sql: 'balance',
      type: 'sum',
      nonAdditiveDimension: {
        name: 'date',
        windowChoice: 'max',
        windowGroupings: ['accountId', 'accountType', 'branchId']
      }
    }
  }
});
```

**生成的 SQL:**
```sql
WITH semi_additive_preprocess AS (
  SELECT
    account_id,
    account_type,
    branch_id,
    DATE_TRUNC('month', date) as month,
    balance,
    MAX(balance) OVER (
      PARTITION BY account_id, account_type, branch_id, DATE_TRUNC('month', date)
    ) as month_end_balance_window
  FROM account_snapshots
)
SELECT
  account_id,
  account_type,
  branch_id,
  month,
  SUM(balance) FILTER (
    WHERE balance = month_end_balance_window
  ) as account_month_end_balance
FROM semi_additive_preprocess
GROUP BY 1, 2, 3, 4;
```

### 4.3 跨数据库兼容性设计（遵循 Cube 架构模式）

Cube 使用继承模式处理数据库差异，半累加指标的数据库兼容性也应遵循这一模式。

**架构模式：BaseQuery + 子类重写**

#### 4.3.1 BaseQuery 添加通用方法

**文件:** `packages/cubejs-schema-compiler/src/adapter/BaseQuery.js`

```javascript
export class BaseQuery {
  // ... 现有方法 ...

  /**
   * 生成半累加指标的条件聚合 SQL
   * 默认实现使用 FILTER 语法（PostgreSQL 风格）
   *
   * 子类可以重写此方法以支持不支持 FILTER 的数据库
   *
   * @param {string} aggregateExpr - 聚合表达式，如 'SUM(balance)'
   * @param {string} condition - 过滤条件，如 'balance = max_balance_window'
   * @returns {string} 条件聚合 SQL
   */
  semiAdditiveAggregateFilter(aggregateExpr, condition) {
    return `${aggregateExpr} FILTER (WHERE ${condition})`;
  }

  /**
   * 生成窗口函数 SQL
   *
   * @param {string} funcName - 窗口函数名，如 'MAX', 'MIN'
   * @param {string} expr - 表达式，如 'balance'
   * @param {string} partitionBy - PARTITION BY 子句
   * @param {string} orderBy - ORDER BY 子句（可选）
   * @returns {string} 窗口函数 SQL
   */
  semiAdditiveWindowFunction(funcName, expr, partitionBy, orderBy = '') {
    const orderByClause = orderBy ? ` ORDER BY ${orderBy}` : '';
    return `${funcName}(${expr}) OVER (${partitionBy}${orderByClause})`;
  }

  /**
   * 检查数据库是否支持 FILTER 语法
   * 默认为 true，子类可以重写
   */
  supportsFilterClause() {
    return true;
  }
}
```

#### 4.3.2 PostgreSQL 实现（使用默认实现）

**文件:** `packages/cubejs-schema-compiler/src/adapter/PostgresQuery.ts`

```typescript
export class PostgresQuery extends BaseQuery {
  // PostgreSQL 支持 FILTER 语法，使用 BaseQuery 的默认实现
  // 无需重写任何半累加相关方法
}
```

#### 4.3.3 SQL Server 实现（重写方法）

**文件:** `packages/cubejs-schema-compiler/src/adapter/MssqlQuery.ts`

```typescript
export class MssqlQuery extends BaseQuery {
  /**
   * 重写：MSSQL 不支持 FILTER，使用 CASE WHEN 替代
   */
  semiAdditiveAggregateFilter(aggregateExpr, condition) {
    // 解析聚合表达式: 'SUM(balance)' -> { func: 'SUM', arg: 'balance' }
    const match = aggregateExpr.match(/(\w+)\(([^)]+)\)/);

    if (!match) {
      throw new UserError(
        `Invalid aggregate expression for semi-additive measure: ${aggregateExpr}`
      );
    }

    const [, func, arg] = match;

    // SUM(balance) FILTER (WHERE balance = max_window)
    // -> SUM(CASE WHEN balance = max_window THEN balance ELSE 0 END)
    return `${func}(CASE WHEN ${condition} THEN ${arg} ELSE 0 END)`;
  }

  /**
   * 重写：MSSQL 不支持 FILTER 语法
   */
  supportsFilterClause() {
    return false;
  }
}
```

#### 4.3.4 Oracle 实现（重写方法）

**文件:** `packages/cubejs-schema-compiler/src/adapter/OracleQuery.ts`

```typescript
export class OracleQuery extends BaseQuery {
  /**
   * 重写：Oracle 不支持 FILTER，使用 CASE WHEN 替代
   */
  semiAdditiveAggregateFilter(aggregateExpr, condition) {
    const match = aggregateExpr.match(/(\w+)\(([^)]+)\)/);

    if (!match) {
      throw new UserError(
        `Invalid aggregate expression for semi-additive measure: ${aggregateExpr}`
      );
    }

    const [, func, arg] = match;
    return `${func}(CASE WHEN ${condition} THEN ${arg} ELSE 0 END)`;
  }

  supportsFilterClause() {
    return false;
  }
}
```

#### 4.3.5 MySQL 8.0+ 实现（使用默认实现）

**文件:** `packages/cubejs-schema-compiler/src/adapter/MysqlQuery.ts`

```typescript
export class MysqlQuery extends BaseQuery {
  // MySQL 8.0+ 支持 FILTER 语法，使用 BaseQuery 的默认实现
}
```

#### 4.3.6 BaseMeasure 使用多态方法

**文件:** `packages/cubejs-schema-compiler/src/adapter/BaseMeasure.ts`

```typescript
export class BaseMeasure {
  /**
   * 生成半累加指标的 SQL（使用 Query 的多态方法）
   */
  private semiAdditiveMeasureSql(): string {
    const config = this.nonAdditiveConfig!;
    const baseSql = this.measureDefinition().sql();

    // 构建窗口函数（调用 Query 的多态方法）
    const partitionBy = this.buildPartitionByForMeasure(config);
    const windowFunc = this.query.semiAdditiveWindowFunction(
      config.windowChoice.toUpperCase(),
      baseSql,
      partitionBy
    );

    // 构建条件聚合（调用 Query 的多态方法）
    const aggregateType = this.measureDefinition().type.toUpperCase();
    const aggregateExpr = `${aggregateType}(${baseSql})`;

    // 多态调用：根据数据库类型自动选择正确的实现
    return this.query.semiAdditiveAggregateFilter(
      aggregateExpr,
      `${baseSql} = (${windowFunc})`
    );
  }

  /**
   * 构建 PARTITION BY 子句
   */
  private buildPartitionByForMeasure(config: NonAdditiveDimensionConfig): string {
    const clauses: string[] = [];

    // 添加时间粒度分区
    const timeGrain = this.query.getTimeDimensionGranularity(config.name);
    if (timeGrain) {
      const dimensionSql = this.query.dimensionSql(config.name);
      // 使用 Query 的 timeGroupedColumn 方法（数据库特定的时间分组）
      clauses.push(
        this.query.timeGroupedColumn(timeGrain, dimensionSql)
      );
    }

    // 添加 windowGroupings
    if (config.windowGroupings) {
      config.windowGroupings.forEach(grouping => {
        clauses.push(this.query.dimensionSql(grouping));
      });
    }

    return clauses.length > 0 ? `PARTITION BY ${clauses.join(', ')}` : '';
  }
}
```

#### 4.3.7 数据库兼容性对比表

| 数据库 | Query 类 | 支持 FILTER | 实现方式 | 是否需要重写方法 |
|-------|---------|------------|---------|--------------|
| PostgreSQL | `PostgresQuery` | ✅ | 使用默认 `BaseQuery` 实现 | ❌ 否 |
| MySQL 8.0+ | `MysqlQuery` | ✅ | 使用默认 `BaseQuery` 实现 | ❌ 否 |
| Snowflake | `SnowflakeQuery` | ✅ | 使用默认 `BaseQuery` 实现 | ❌ 否 |
| BigQuery | `BigqueryQuery` | ✅ | 使用默认 `BaseQuery` 实现 | ❌ 否 |
| Redshift | `RedshiftQuery` | ✅ | 使用默认 `BaseQuery` 实现 | ❌ 否 |
| SQL Server | `MssqlQuery` | ❌ | 重写 `semiAdditiveAggregateFilter()` | ✅ 是 |
| Oracle | `OracleQuery` | ❌ | 重写 `semiAdditiveAggregateFilter()` | ✅ 是 |

#### 4.3.8 SQL 生成对比示例

**PostgreSQL / MySQL 8.0+ / Snowflake / BigQuery / Redshift:**
```sql
-- 使用 FILTER 语法
SELECT
  user_id,
  month,
  SUM(balance) FILTER (WHERE balance = max_balance_window) as month_end_balance
FROM semi_additive_preprocess
GROUP BY user_id, month;
```

**SQL Server / Oracle:**
```sql
-- 使用 CASE WHEN 替代 FILTER
SELECT
  user_id,
  month,
  SUM(CASE WHEN balance = max_balance_window THEN balance ELSE 0 END) as month_end_balance
FROM semi_additive_preprocess
GROUP BY user_id, month;
```

#### 4.3.9 扩展新数据库支持

如果要为新的数据库添加半累加支持，只需：

```typescript
export class NewDatabaseQuery extends BaseQuery {
  // 如果数据库不支持 FILTER 语法
  semiAdditiveAggregateFilter(aggregateExpr, condition) {
    // 实现该数据库特定的语法
    return `${aggregateExpr} ${this.databaseSpecificFilterSyntax(condition)}`;
  }

  // 如果数据库的窗口函数语法不同
  semiAdditiveWindowFunction(funcName, expr, partitionBy, orderBy) {
    // 实现该数据库特定的窗口函数语法
    return this.databaseSpecificWindowSyntax(funcName, expr, partitionBy, orderBy);
  }
}
```

**设计优势：**
- ✅ 遵循 Cube 的现有架构模式（继承 + 多态）
- ✅ 利用多态，代码复用性好
- ✅ 每个数据库的差异封装在各自的 Query 类中
- ✅ 易于扩展新数据库
- ✅ 符合开闭原则（对扩展开放，对修改关闭）
- ✅ BaseMeasure 不需要知道具体数据库类型

---

## 5. 实现步骤

### Phase 1: 核心类型和验证（1-2周）

- [ ] **Step 1.1**: 扩展 `MeasureDefinition` 类型
  - 文件: `packages/cubejs-schema-compiler/src/compiler/CubeEvaluator.ts`
  - 添加 `NonAdditiveDimensionConfig` 类型

- [ ] **Step 1.2**: 扩展 `BaseMeasure` 类
  - 文件: `packages/cubejs-schema-compiler/src/adapter/BaseMeasure.ts`
  - 添加 `isSemiAdditive()` 方法
  - 添加 `nonAdditiveConfig` 属性
  - 修改 `isAdditive()` 方法

- [ ] **Step 1.3**: 添加验证逻辑
  - 文件: `packages/cubejs-schema-compiler/src/compiler/CubeValidator.ts`
  - 添加 `validateNonAdditiveDimension()` 方法

### Phase 2: SQL 生成逻辑（2-3周）

- [ ] **Step 2.1**: 扩展 `BaseQuery` 基类
  - 文件: `packages/cubejs-schema-compiler/src/adapter/BaseQuery.js`
  - 添加 `semiAdditiveAggregateFilter()` 方法
  - 添加 `semiAdditiveWindowFunction()` 方法
  - 添加 `supportsFilterClause()` 方法

- [ ] **Step 2.2**: 实现 `BaseMeasure.semiAdditiveMeasureSql()` 方法
  - 文件: `packages/cubejs-schema-compiler/src/adapter/BaseMeasure.ts`
  - 使用 Query 的多态方法生成 SQL
  - 支持不同的 `windowChoice` 选项
  - 实现 `buildPartitionByForMeasure()` 方法

- [ ] **Step 2.3**: 扩展 `QueryBuilder`
  - 文件: `packages/cubejs-schema-compiler/src/adapter/QueryBuilder.ts`
  - 实现 `buildSemiAdditiveSelectClause()` 方法
  - 实现 CTE 生成逻辑
  - 处理混合查询（半累加 + 全累加指标）

- [ ] **Step 2.4**: 跨数据库适配
  - 文件: `packages/cubejs-schema-compiler/src/adapter/MssqlQuery.ts`
  - 重写 `semiAdditiveAggregateFilter()` 方法（使用 CASE WHEN）
  - 文件: `packages/cubejs-schema-compiler/src/adapter/OracleQuery.ts`
  - 重写 `semiAdditiveAggregateFilter()` 方法（使用 CASE WHEN）
  - 验证其他数据库（PostgreSQL, MySQL, Snowflake, BigQuery, Redshift）使用默认实现

### Phase 3: Pre-Aggregation 支持（可选，2-3周）

- [ ] **Step 3.1**: 扩展 Pre-Aggregation 定义
  - 文件: `packages/cubejs-schema-compiler/src/compiler/CubeSymbols.ts`
  - 支持半可加指标的预聚合

- [ ] **Step 3.2**: 实现 Pre-Aggregation SQL 生成
  - 文件: `packages/cubejs-schema-compiler/src/adapter/PreAggregations.ts`

### Phase 4: 测试和文档（1-2周）

- [ ] **Step 4.1**: 单元测试
- [ ] **Step 4.2**: 集成测试
- [ ] **Step 4.3**: 文档和示例

---

## 6. 测试方案

### 6.1 单元测试

**文件:** `packages/cubejs-schema-compiler/test/unit/BaseMeasure.test.ts`

```typescript
describe('BaseMeasure - Semi-Additive Measures', () => {
  let query;
  let cubeEvaluator;

  beforeEach(() => {
    cubeEvaluator = createMockCubeEvaluator();
    query = new PostgresQuery({
      cubeEvaluator,
      // ... 其他配置
    }, {});
  });

  describe('isSemiAdditive()', () => {
    test('should return true for semi-additive measures', () => {
      const measure = new BaseMeasure(query, {
        name: 'monthEndBalance',
        type: 'sum',
        sql: () => 'balance',
        nonAdditiveDimension: {
          name: 'date',
          windowChoice: 'max'
        }
      });

      expect(measure.isSemiAdditive()).toBe(true);
    });

    test('should return false for regular measures', () => {
      const measure = new BaseMeasure(query, {
        name: 'totalSales',
        type: 'sum',
        sql: () => 'amount'
      });

      expect(measure.isSemiAdditive()).toBe(false);
    });
  });

  describe('isAdditive()', () => {
    test('should return false for semi-additive measures', () => {
      const measure = new BaseMeasure(query, {
        name: 'monthEndBalance',
        type: 'sum',
        sql: () => 'balance',
        nonAdditiveDimension: {
          name: 'date',
          windowChoice: 'max'
        }
      });

      expect(measure.isAdditive()).toBe(false);
    });
  });

  describe('semiAdditiveMeasureSql()', () => {
    test('should generate correct SQL for max window choice', () => {
      const measure = new BaseMeasure(query, {
        name: 'monthEndBalance',
        type: 'sum',
        sql: () => 'balance',
        nonAdditiveDimension: {
          name: 'date',
          windowChoice: 'max'
        }
      });

      const sql = measure.measureSql();

      expect(sql).toContain('OVER (PARTITION BY');
      expect(sql).toContain('MAX(');
      expect(sql).toContain('FILTER (WHERE');
    });

    test('should generate correct SQL for min window choice', () => {
      const measure = new BaseMeasure(query, {
        name: 'monthStartBalance',
        type: 'sum',
        sql: () => 'balance',
        nonAdditiveDimension: {
          name: 'date',
          windowChoice: 'min'
        }
      });

      const sql = measure.measureSql();

      expect(sql).toContain('MIN(');
    });

    test('should support window groupings', () => {
      const measure = new BaseMeasure(query, {
        name: 'userMonthEndBalance',
        type: 'sum',
        sql: () => 'balance',
        nonAdditiveDimension: {
          name: 'date',
          windowChoice: 'max',
          windowGroupings: ['userId', 'accountId']
        }
      });

      const sql = measure.measureSql();

      expect(sql).toContain('userId');
      expect(sql).toContain('accountId');
    });
  });
});
```

**数据库兼容性单元测试:**

**文件:** `packages/cubejs-schema-compiler/test/unit/database-compatibility.test.ts`

```typescript
describe('Semi-Additive Measures - Database Compatibility', () => {
  describe('PostgreSQL', () => {
    test('should use FILTER syntax', () => {
      const query = new PostgresQuery(/* ... */);
      const filterSql = query.semiAdditiveAggregateFilter(
        'SUM(balance)',
        'balance = max_window'
      );

      expect(filterSql).toBe('SUM(balance) FILTER (WHERE balance = max_window)');
      expect(query.supportsFilterClause()).toBe(true);
    });
  });

  describe('SQL Server', () => {
    test('should use CASE WHEN syntax', () => {
      const query = new MssqlQuery(/* ... */);
      const filterSql = query.semiAdditiveAggregateFilter(
        'SUM(balance)',
        'balance = max_window'
      );

      expect(filterSql).toBe(
        'SUM(CASE WHEN balance = max_window THEN balance ELSE 0 END)'
      );
      expect(query.supportsFilterClause()).toBe(false);
    });
  });

  describe('Oracle', () => {
    test('should use CASE WHEN syntax', () => {
      const query = new OracleQuery(/* ... */);
      const filterSql = query.semiAdditiveAggregateFilter(
        'SUM(balance)',
        'balance = max_window'
      );

      expect(filterSql).toBe(
        'SUM(CASE WHEN balance = max_window THEN balance ELSE 0 END)'
      );
      expect(query.supportsFilterClause()).toBe(false);
    });
  });

  describe('MySQL 8.0+', () => {
    test('should use FILTER syntax', () => {
      const query = new MysqlQuery(/* ... */);
      const filterSql = query.semiAdditiveAggregateFilter(
        'SUM(balance)',
        'balance = max_window'
      );

      expect(filterSql).toBe('SUM(balance) FILTER (WHERE balance = max_window)');
      expect(query.supportsFilterClause()).toBe(true);
    });
  });
});
```

### 6.2 集成测试

**文件:** `packages/cubejs-schema-compiler/test/integration/semi-additive-measures.test.ts`

```typescript
describe('Semi-Additive Measures Integration', () => {
  let compilers;

  describe('PostgreSQL', () => {
    beforeAll(() => {
      compilers = createCompilers('postgres');
    });

    test('should query month-end balance correctly', async () => {
      const query = {
        measures: ['AccountBalances.monthEndBalance'],
        timeDimensions: [{
          dimension: 'AccountBalances.date',
          granularity: 'month'
        }]
      };

      const { sql, params } = await compilers.compiler.compile(query);

      // 验证生成的 SQL 包含 CTE
      expect(sql).toContain('WITH semi_additive_preprocess AS');
      expect(sql).toContain('MAX(balance) OVER');
      expect(sql).toContain('FILTER (WHERE balance =');
    });

    test('should work with window groupings', async () => {
      const query = {
        measures: ['AccountBalances.userMonthEndBalance'],
        dimensions: ['AccountBalances.userId'],
        timeDimensions: [{
          dimension: 'AccountBalances.date',
          granularity: 'month'
        }]
      };

      const { sql } = await compilers.compiler.compile(query);

      expect(sql).toContain('PARTITION BY');
      expect(sql).toContain('user_id');
    });
  });

  describe('SQL Server', () => {
    beforeAll(() => {
      compilers = createCompilers('mssql');
    });

    test('should use CASE WHEN instead of FILTER', async () => {
      const query = {
        measures: ['AccountBalances.monthEndBalance'],
        timeDimensions: [{
          dimension: 'AccountBalances.date',
          granularity: 'month'
        }]
      };

      const { sql } = await compilers.compiler.compile(query);

      // 验证不使用 FILTER，而是使用 CASE WHEN
      expect(sql).not.toContain('FILTER (WHERE');
      expect(sql).toContain('CASE WHEN balance =');
      expect(sql).toContain('THEN balance ELSE 0 END');
    });
  });
});
```

### 6.3 端到端测试

**文件:** `packages/cubejs-schema-compiler/test/e2e/semi-additive-measures.e2e.test.ts`

```typescript
describe('Semi-Additive Measures E2E', () => {
  test('should calculate month-end balance correctly', async () => {
    // 准备测试数据
    await setupTestData([
      { date: '2024-01-01', account_id: 1, balance: 100 },
      { date: '2024-01-15', account_id: 1, balance: 150 },
      { date: '2024-01-31', account_id: 1, balance: 200 },
      { date: '2024-02-01', account_id: 1, balance: 200 },
      { date: '2024-02-28', account_id: 1, balance: 250 },
    ]);

    const result = await runQuery({
      measures: ['AccountBalances.monthEndBalance'],
      timeDimensions: [{
        dimension: 'AccountBalances.date',
        granularity: 'month',
        dateRange: '2024-01-01..2024-02-29'
      }]
    });

    // 验证结果
    expect(result).toHaveLength(2);
    expect(result[0]['AccountBalances.monthEndBalance']).toBe(200); // 1月末
    expect(result[1]['AccountBalances.monthEndBalance']).toBe(250); // 2月末

    // 验证不是简单累加（简单累加会是 100+150+200+200+250 = 900）
    expect(result[0]['AccountBalances.monthEndBalance']).not.toBe(450);
  });

  test('should calculate per-user month-end balance', async () => {
    await setupTestData([
      { date: '2024-01-31', user_id: 1, balance: 100 },
      { date: '2024-01-31', user_id: 2, balance: 200 },
      { date: '2024-02-28', user_id: 1, balance: 150 },
      { date: '2024-02-28', user_id: 2, balance: 250 },
    ]);

    const result = await runQuery({
      measures: ['AccountBalances.userMonthEndBalance'],
      dimensions: ['AccountBalances.userId'],
      timeDimensions: [{
        dimension: 'AccountBalances.date',
        granularity: 'month'
      }]
    });

    expect(result).toHaveLength(4); // 2个月 x 2个用户

    // 1月末
    const user1Jan = result.find(r => r['AccountBalances.userId'] === 1 && r['AccountBalances.dateMonth'].startsWith('2024-01'));
    expect(user1Jan['AccountBalances.userMonthEndBalance']).toBe(100);

    const user2Jan = result.find(r => r['AccountBalances.userId'] === 2 && r['AccountBalances.dateMonth'].startsWith('2024-01'));
    expect(user2Jan['AccountBalances.userMonthEndBalance']).toBe(200);
  });
});
```

### 6.4 性能测试

```typescript
describe('Semi-Additive Measures Performance', () => {
  test('should use efficient execution plan', async () => {
    await setupLargeDataset(100000); // 10万条记录

    const query = {
      measures: ['AccountBalances.monthEndBalance'],
      timeDimensions: [{
        dimension: 'AccountBalances.date',
        granularity: 'month',
        dateRange: '2024-01-01..2024-12-31'
      }]
    };

    const startTime = Date.now();
    const result = await runQuery(query);
    const duration = Date.now() - startTime;

    // 验证使用了窗口函数（通过 EXPLAIN 检查）
    const explainResult = await runExplain(query);
    expect(explainResult.plan).toContain('Window');

    // 验证查询在合理时间内完成（< 5秒）
    expect(duration).toBeLessThan(5000);
    expect(result).toHaveLength(12); // 12个月
  });

  test('should benefit from pre-aggregations', async () => {
    // 测试预聚合的性能提升
    const withPreAgg = await measureQueryTime({
      measures: ['AccountBalances.monthEndBalance'],
      preAggregation: true
    });

    const withoutPreAgg = await measureQueryTime({
      measures: ['AccountBalances.monthEndBalance'],
      preAggregation: false
    });

    // 预聚合应该显著 faster（至少快 2 倍）
    expect(withoutPreAgg / withPreAgg).toBeGreaterThan(2);
  });
});
```

### 6.5 测试覆盖率目标

| 测试类型 | 覆盖率目标 | 重点 |
|---------|----------|------|
| 单元测试 | 80%+ | BaseMeasure, CubeValidator, Query 方法 |
| 集成测试 | 主要流程 | SQL 生成、CTE 结构 |
| E2E 测试 | 关键场景 | 月末余额、按用户分组 |
| 性能测试 | 基准测试 | 查询时间、执行计划 |

---

## 7. 向后兼容性

### 7.1 兼容性保证

- ✅ **现有 Schema 无需修改**：不定义 `nonAdditiveDimension` 的 measure 行为不变
- ✅ **现有 API 不变**：REST、GraphQL、SQL 查询接口保持一致
- ✅ **性能不受影响**：仅对使用半可加指标的查询添加额外处理

### 7.2 迁移路径

**现有 Workaround 用户：**

```javascript
// 旧方案：使用原生 SQL
cube('AccountBalances', {
  measures: {
    monthEndBalance: {
      sql: `
        CASE
          WHEN date = (
            SELECT MAX(date)
            FROM account_snapshots s2
            WHERE s2.account_id = account_snapshots.account_id
            AND DATE_TRUNC('month', s2.date) = DATE_TRUNC('month', account_snapshots.date)
          )
          THEN balance
          ELSE 0
        END
      `,
      type: 'sum'
    }
  }
});

// 新方案：使用半可加配置（更简洁、更高效）
cube('AccountBalances', {
  measures: {
    monthEndBalance: {
      sql: 'balance',
      type: 'sum',
      nonAdditiveDimension: {
        name: 'date',
        windowChoice: 'max'
      }
    }
  }
});
```

---

## 8. 未来扩展

### 8.2 Phase 2 功能

- [ ] **Avg 窗口函数**：支持时间窗口内的平均值
- [ ] **自定义窗口帧**：支持 `ROWS BETWEEN` 语法
- [ ] **多时间粒度支持**：同时支持月度和季度粒度

### 8.3 高级功能

- [ ] **智能聚合选择**：根据查询自动选择最佳聚合策略
- [ ] **增量预聚合**：支持半可加指标的增量刷新
- [ ] **混合计算**：支持半可加和全可加指标的混合计算

---

## 9. 参考资料

### 9.1 相关文档

- [dbt Metricflow - Non-Additive Dimensions](https://docs.getdbt.com/docs/build/measures#non-additive-dimensions)
- [SQL Window Functions - PostgreSQL Documentation](https://www.postgresql.org/docs/current/functions-window.html)
- [Cube.js Architecture](https://cube.dev/docs/concepts/architecture)

### 9.2 代码文件清单

| 文件路径 | 修改类型 | 说明 |
|---------|---------|------|
| `packages/cubejs-schema-compiler/src/compiler/CubeEvaluator.ts` | 修改 | 添加 NonAdditiveDimensionConfig 类型定义 |
| `packages/cubejs-schema-compiler/src/compiler/CubeValidator.ts` | 修改 | 添加 validateNonAdditiveDimension() 验证方法 |
| `packages/cubejs-schema-compiler/src/adapter/BaseQuery.js` | 修改 | 添加半累加通用方法（多态方法） |
| `packages/cubejs-schema-compiler/src/adapter/BaseMeasure.ts` | 修改 | 添加半累加检测和 SQL 生成逻辑 |
| `packages/cubejs-schema-compiler/src/adapter/QueryBuilder.ts` | 修改 | 添加 CTE 生成逻辑，处理半累加查询 |
| `packages/cubejs-schema-compiler/src/adapter/MssqlQuery.ts` | 修改 | 重写 semiAdditiveAggregateFilter() 方法 |
| `packages/cubejs-schema-compiler/src/adapter/OracleQuery.ts` | 修改 | 重写 semiAdditiveAggregateFilter() 方法 |
| `packages/cubejs-schema-compiler/test/unit/BaseMeasure.test.ts` | 新增 | 单元测试 |
| `packages/cubejs-schema-compiler/test/integration/semi-additive-measures.test.ts` | 新增 | 集成测试 |

---

## 10. 附录

### 10.1 常见问题 (FAQ)

**Q1: 半可加指标与滚动窗口的区别是什么？**

- **滚动窗口（Rolling Window）**：用于计算移动平均值、总和等（如 7 日移动平均）
- **半可加指标**：用于在特定维度上禁用累加（如月末余额）

**Q2: 性能影响如何？**

使用窗口函数的性能通常优于子查询方案，并且可以通过预聚合进一步优化。

**Q3: 支持哪些数据库？**

所有支持窗口函数的数据库（PostgreSQL、MySQL 8.0+、Snowflake、BigQuery、Redshift 等）。

### 10.2 术语表

| 术语 | 英文 | 解释 |
|-----|------|------|
| 半可加指标 | Semi-Additive Measure | 只能在某些维度上聚合的指标 |
| 窗口函数 | Window Function | SQL 的 OVER 子句函数 |
| 非可加维度 | Non-Additive Dimension | 不能简单累加的维度（通常是时间） |
| 时点值 | Point-in-Time Value | 特定时间点的数据快照 |
| 期末值 | Period-End Value | 会计期末的值（如月末余额） |

---

**文档结束**
