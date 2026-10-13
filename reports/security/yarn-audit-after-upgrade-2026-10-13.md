# 高危依赖升级后 Yarn 审计（2026-10-13）

基于本次依赖升级后的 `yarn.lock`，运行 `yarn audit --json`。

## 汇总

- 基线：54 个组件、179 条公告，其中高危 94 条。
- 当前：35 个组件、79 条公告；严重 0、高危 31、中危 36、低危 12。
- Yarn 审计退出码 14；按公告 ID 去重，相同公告的多条依赖路径只计一次。
- 逐项公告、修复范围和一条依赖路径示例见 `yarn-audit-after-upgrade-2026-10-13.csv`。

## 仍命中高危的组件

| 组件 | 命中版本 | 高危公告数 | 依赖路径示例 |
| --- | --- | ---: | --- |
| js-yaml | 3.14.0, 4.1.1 | 6 | lerna > js-yaml |
| minimatch | 3.0.5, 9.0.3 | 6 | lerna > @lerna/create > minimatch |
| nx | 22.2.0 | 3 | lerna > nx |
| undici | 5.29.0 | 3 | @cubejs-backend/testing-shared > testcontainers > undici |
| linkify-it | 3.0.3 | 2 | @cubejs-client/playground > graphiql > markdown-it > linkify-it |
| thrift | 0.20.0 | 2 | @cubejs-backend/hive-driver > thrift |
| toml | 3.0.0 | 2 | @cubejs-backend/snowflake-driver > snowflake-sdk > toml |
| @fastify/busboy | 2.1.1 | 1 | @cubejs-backend/testing-shared > testcontainers > undici > @fastify/busboy |
| basic-ftp | 5.3.1 | 1 | @cubejs-backend/shared > proxy-agent > pac-proxy-agent > get-uri > basic-ftp |
| braces | 3.0.3 | 1 | @cubejs-backend/cloud > chokidar > braces |
| http-cache-semantics | 4.1.1 | 1 | lerna > make-fetch-happen > http-cache-semantics |
| pacote | 21.0.1 | 1 | lerna > pacote |
| picomatch | 4.0.2 | 1 | @rollup/plugin-json > @rollup/pluginutils > picomatch |
| tmp | 0.0.33 | 1 | cubejs-cli > inquirer > external-editor > tmp |

## 处理边界

- `nx@22.7.9` 自身修复 3 条高危公告，但其精确依赖会引入旧版 Axios、brace-expansion 和 smol-toml 的高危告警；保留原锁定版本 22.2.0。
- `braces` 与 `http-cache-semantics` 的高危公告标记为暂无修复版本；Thrift 的两条高危中有一条同样暂无修复版本。
- `minimatch`、`js-yaml`、`picomatch`、`pacote`、`tmp` 有上游精确或旧范围锁定；`undici`、`@fastify/busboy`、`toml`、`linkify-it` 涉及上游主版本升级。
- Express 4.22.0 修复了 `path-to-regexp` 高危，但其 `qs@~6.14.0` 依赖新增一条中危公告；修复版 `qs>=6.16.0` 不在该范围内。
