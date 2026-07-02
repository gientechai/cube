# Cube 行列权限 — Load 接口响应说明

> **文档版本**：v1.0
> **编写日期**：2026-06-29
> **适用接口**：REST (JSON) API `GET/POST /cubejs-api/v1/load`
> **实现版本**：Cube fork `v1.6.61`（`@cubejs-backend/api-gateway` + `@cubejs-backend/server-core` + `@cubejs-backend/native`）
> **对接方**：GienBI / Java 后端、前端图表渲染

---

## 1. 概述

在启用 `access_policy`（RBAC）后，Load 接口在列权限场景下有两种新增响应行为：

| 场景 | HTTP 状态码 | 说明 |
|------|-------------|------|
| **列权限禁用** | `400` | 用户无权查询被禁用的列，请求在编译阶段被拒绝 |
| **列脱敏查询** | `200` | 查询成功，`data` 中对应字段为脱敏值，响应附带 `maskedMembers` 元数据 |

两种行为均依赖 JWT `securityContext`（`roles` / `userAttributes`）与 Cube Schema 中的 `access_policy` 配置。

---

## 2. 公共约定

### 2.1 请求入口

```
GET  /cubejs-api/v1/load?query=<JSON 编码的查询>
POST /cubejs-api/v1/load
Content-Type: application/json

{
  "query": { ... }
}
```

`query` 为标准 Cube JSON Query（`dimensions`、`measures`、`filters` 等）。

> **注意**：客户端不得在请求中传入 `maskedMembers` 字段，否则返回 `400`：`maskedMembers cannot be provided in the query`。

### 2.2 权限判定时机

列权限在 `applyRowLevelSecurity` 阶段生效，早于 SQL 执行：

- **`member_level` 禁止**（`excludes` 且未配置 `member_masking`）→ 直接 `400`，不返回数据
- **`member_masking` 脱敏** → 查询继续执行，结果字段替换为 mask 表达式返回值（如 `***` + 末字符）

### 2.3 成员标识字段说明

响应中的 `member` 均为 **完整成员路径**，格式：`{cube}.{member}`，例如 `score1.subject`。

`title` / `displayTitle` 解析优先级：

1. Schema 中成员自定义 `title`
2. Meta 中的 `title` / `shortTitle`
3. 回退为 `{cubeTitle} {memberShortName}` / `{memberShortName}`

| 字段 | 含义 | 示例 |
|------|------|------|
| `member` | 成员完整路径 | `score1.subject` |
| `title` | 完整展示名（常含 cube 名） | `score1 学科` |
| `displayTitle` | 短标题（优先用于 UI 展示） | `学科` |

---

## 3. 列权限禁用 — 错误响应

### 3.1 触发条件

用户对某 cube 命中 `access_policy`，且查询涉及的列成员满足：

- 在 `member_level.excludes` 中（或不在 `includes` 允许范围内）
- **未**配置为 `member_masking` 脱敏列

常见 Schema 配置示例：

```javascript
access_policy: [
  {
    role: 'student',
    member_level: {
      includes: '*',
      excludes: ['subject'],  // 禁用 subject 列
    },
    // 无 member_masking → 查询 subject 时报错
  },
]
```

### 3.2 HTTP 响应

**状态码**：`400 Bad Request`

**响应体**：

```json
{
  "error": "Access denied: you do not have permission to query the following members: score1.subject (学科)",
  "deniedMembers": [
    {
      "member": "score1.subject",
      "title": "score1 学科",
      "displayTitle": "学科"
    }
  ]
}
```

### 3.3 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `error` | `string` | 是 | 人类可读错误信息，列出被拒绝的成员 |
| `deniedMembers` | `array` | 否 | 结构化拒绝列表；有具体成员时一定返回 |
| `deniedMembers[].member` | `string` | 是 | 被拒绝的成员路径 |
| `deniedMembers[].title` | `string` | 是 | 完整展示名 |
| `deniedMembers[].displayTitle` | `string` | 是 | 短标题，推荐前端用于提示文案 |
| `requestId` | `string` | 否 | 开发模式或 Playground 签名请求时返回，便于排查 |
| `stack` | `string` | 否 | 仅 `devMode` 下返回堆栈 |

### 3.4 多列同时被拒绝

`deniedMembers` 为数组，成员去重后按字母序排列；`error` 文案以逗号拼接所有成员。

```json
{
  "error": "Access denied: you do not have permission to query the following members: score1.subject (学科), score1.teacher (任课教师)",
  "deniedMembers": [
    {
      "member": "score1.subject",
      "title": "score1 学科",
      "displayTitle": "学科"
    },
    {
      "member": "score1.teacher",
      "title": "score1 任课教师",
      "displayTitle": "任课教师"
    }
  ]
}
```

### 3.5 前端处理建议

```text
if (response.status === 400 && body.deniedMembers?.length) {
  // 使用 displayTitle 拼接用户提示，例如：
  //「您无权查看以下字段：学科、任课教师」
  const labels = body.deniedMembers.map(m => m.displayTitle || m.title);
  showPermissionError(labels);
}
```

---

## 4. 列脱敏 — 成功响应

### 4.1 触发条件

用户对某 cube 命中 `access_policy`，且查询涉及的列成员在 `member_masking.includes` 中。

#### SQL 阶段脱敏（默认，历史兼容）

```js
access_policy: [
  {
    role: `student`,
    member_level: {
      includes: `*`,
      excludes: [`subject`],
    },
    member_masking: {
      includes: [`subject`],
    },
  },
],

// score1 cube 成员定义
subject: {
  type: `string`,
  title: `学科`,
  mask: ({ value }) => (value ? `***${value.slice(-1)}` : `***`),
},
```

#### 结果阶段脱敏（`mode: "result"`）

```js
access_policy: [
  {
    role: `student`,
    member_level: {
      includes: `*`,
      excludes: [`name`],
    },
    member_masking: {
      mode: `result`,
      includes: [`name`],
      rules: [
        {
          member: `users.name`,
          result_mask: {
            type: `NAME`,
            desensitize_type: `NO_DESENSITIZE`,
            config: {},
          },
        },
      ],
    },
  },
],
```

详见 [脱敏 mask 与 result_mask 说明](./Cube行列权限-脱敏mask与result_mask说明.md)。

### 4.2 HTTP 响应

**状态码**：`200 OK`

#### 4.2.1 单查询（regularQuery，最常见）

响应为**扁平结构**（非 `results` 数组包裹）：

```json
{
  "query": {
    "dimensions": ["score1.subject"],
    "measures": ["score1.count"],
    "limit": 100,
    "timezone": "UTC",
    "filters": [],
    "timeDimensions": [],
    "maskedMembers": [
      {
        "member": "score1.subject",
        "title": "score1 学科",
        "displayTitle": "学科"
      }
    ]
  },
  "annotation": {
    "measures": { ... },
    "dimensions": {
      "score1.subject": {
        "title": "score1 学科",
        "shortTitle": "学科",
        "type": "string"
      }
    },
    "segments": {},
    "timeDimensions": {}
  },
  "data": [
    {
      "score1.subject": "***学",
      "score1.count": "42"
    },
    {
      "score1.subject": "***语",
      "score1.count": "38"
    }
  ],
  "lastRefreshTime": "2026-06-29T08:00:00.000Z"
}
```

#### 4.2.2 多查询 / 混合查询（blending、compareDateRange 等）

响应包含 `results` 与 `pivotQuery`：

```json
{
  "queryType": "regularQuery",
  "slowQuery": false,
  "pivotQuery": {
    "dimensions": ["score1.subject"],
    "measures": ["score1.count"],
    "queryType": "regularQuery",
    "maskedMembers": [
      {
        "member": "score1.subject",
        "title": "score1 学科",
        "displayTitle": "学科"
      }
    ]
  },
  "results": [
    {
      "query": {
        "dimensions": ["score1.subject"],
        "measures": ["score1.count"],
        "maskedMembers": [
          {
            "member": "score1.subject",
            "title": "score1 学科",
            "displayTitle": "学科"
          }
        ]
      },
      "annotation": { ... },
      "data": [
        { "score1.subject": "***学", "score1.count": "42" }
      ],
      "lastRefreshTime": "2026-06-29T08:00:00.000Z"
    }
  ]
}
```

### 4.3 `maskedMembers` 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `member` | `string` | 是 | 被脱敏的成员路径 |
| `title` | `string` | 否 | 完整展示名（来自 annotation） |
| `displayTitle` | `string` | 否 | 短标题（来自 `shortTitle` 或 `title`） |
| `filter` | `object` | 否 | 脱敏策略附带的行级过滤条件；多数场景不出现 |

> `title` / `displayTitle` 由 API Gateway 根据本次查询的 `annotation` 补全；若 annotation 中无对应元数据，则可能省略。

### 4.4 `maskedMembers` 出现位置

| 响应结构 | 路径 | 说明 |
|----------|------|------|
| 单查询 | `query.maskedMembers` | **推荐前端读取此字段** |
| 多查询 | `results[i].query.maskedMembers` | 每个子查询各自的脱敏列表 |
| 多查询 | `pivotQuery.maskedMembers` | 合并后的 pivot 级脱敏列表（需新版 `index.node`） |

单查询响应**不含**顶层 `pivotQuery`。

### 4.5 `data` 中的脱敏值

- **SQL 阶段**（无 `member_masking.mode: "result"`）：脱敏由成员 `mask` / `mask.sql` 在 SQL 编译阶段完成，`data` 中为 SQL 返回值
- **结果阶段**（`mode: "result"` + `rules[].result_mask`）：SQL 返回原始值，Gateway 在返回前按 `type` / `desensitize_type` / `config` 改写 `data`
- `data` 中对应 key 仍为原始成员名（如 `score1.subject`）
- 非脱敏字段（如 `score1.count`）返回真实值

### 4.6 前端处理建议

```text
// 1. 判断哪些列需要展示「已脱敏」标识
const masked = response.query?.maskedMembers
  ?? response.results?.[0]?.query?.maskedMembers
  ?? [];

const maskedSet = new Set(masked.map(m => m.member));

// 2. 表头/tooltip 使用 displayTitle
for (const col of columns) {
  if (maskedSet.has(col.member)) {
    col.headerSuffix = '（已脱敏）';
    const meta = masked.find(m => m.member === col.member);
    col.label = meta?.displayTitle ?? col.label;
  }
}

// 3. data 值已是脱敏后的字符串，直接渲染，无需客户端二次 mask
```

---

## 5. 对比总结

| 维度 | 列权限禁用 | 列脱敏 |
|------|-----------|--------|
| HTTP 状态 | `400` | `200` |
| 是否有 `data` | 否 | 是 |
| 关键扩展字段 | `deniedMembers` | `query.maskedMembers` / `pivotQuery.maskedMembers` |
| Schema 配置 | `member_level.excludes`（无 `member_masking`） | `member_masking.includes` + 成员 `mask` | `member_masking.mode: "result"` + `rules[].result_mask` |
| 用户感知 | 无权限，应提示并阻止展示 | 有数据但敏感字段已遮盖 |

---

## 6. 示例：完整请求 / 响应

### 6.1 脱敏查询

**请求**：

```http
POST /cubejs-api/v1/load
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "query": {
    "dimensions": ["score1.subject"],
    "measures": ["score1.count"]
  }
}
```

**响应** `200`：见 [§4.2.1](#421-单查询regularquery最常见)。

### 6.2 禁用列查询

**请求**（同上，但 `subject` 仅禁用、未配置脱敏）：

**响应** `400`：见 [§3.2](#32-http-响应)。

---

## 7. 依赖与版本说明

| 能力 | 依赖组件 | 备注 |
|------|----------|------|
| `deniedMembers` 结构化错误 | `api-gateway` + `server-core` | `yarn tsc` 即可 |
| `query.maskedMembers` 含 title | `api-gateway` | `enrichMaskedMembersForResponse` |
| `pivotQuery.maskedMembers` | `native`（`index.node`） | 需 `yarn native:build-release` 重编 |

---

## 8. 相关文档

- [Cube 行列权限 access_policy 方案设计](./Cube行列权限-access_policy-方案设计.md)
- [Cube 行列权限 — 脱敏 mask 与 result_mask 说明](./Cube行列权限-脱敏mask与result_mask说明.md)
- Cube 官方 Load API：[REST (JSON) API — Load](https://cube.dev/docs/reference/core-data-apis/rest-api#load)
