# 查询能力模块

专题相关的 SQL 规划放在本目录，**不要**继续往 `BaseQuery.js` 里堆。

## 约定

1. 新增查询能力 → 在 `capabilities/` 下新建文件，在 `install.js` 的 `QUERY_CAPABILITIES` 中注册，并把方法名补进 `queryCapabilities.d.ts`。
2. `BaseQuery` 只做编排（路径选择）。能力通过 `installQueryCapabilities` 挂到 `BaseQuery.prototype`——**禁止**再写手工 thin delegate。
3. 数据库差异 → 在各方言 `*Query` 上通过 hook 覆盖（原型链 override）。
4. 能力交叉 → 独立 bridge 小模块（例如 `periodAverageSemiAdditive.js`），通过 `this.*` 协作，禁止互相拷贝大段 SQL。
5. 内核原语留在 `BaseQuery` / 方言 hook（`timeGroupedColumn`、`minGranularity`、`evaluateSql`、`applyMeasureFilters` 等）。
6. 真正重复的小段实现 → 微型 util（例如 `measureSqlUtils.js`），不要做成万能 commons。

## 现有模块

| 文件 | 说明 |
|---|---|
| `install.js` | Mixin 安装入口（`installQueryCapabilities`） |
| `queryCapabilities.d.ts` | 挂载方法的类型增强（方法名需与 capability 同步） |
| `semiAdditive.js` | 时点 / 半累加指标（`nonAdditiveDimension`） |
| `periodAverage.js` | 期间日均 / 月均等（period_average） |
| `periodAverageSemiAdditive.js` | 交叉桥：月日均 × 半累加协作 |
| `measureFilter.js` | 外层 measure filter 包装（`HAVING` → 子查询 `WHERE`） |
| `measureSqlUtils.js` | 共享原始 measure 列投影（`rawMeasureSql`） |
