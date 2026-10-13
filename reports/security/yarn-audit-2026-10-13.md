# Yarn 依赖漏洞审计（2026-10-13）

基于当前提交 `f4ccca310` 的 `yarn.lock`，运行 `yarn audit --json`。审计退出码 14 表示仍有告警。

## 汇总

- 命中组件：54 个；按 Yarn 公告 ID 去重：179 条。
- 严重等级（去重）：严重 0、高危 94、中危 69、低危 16。
- Yarn 原始记录：1295 条；相同公告在不同依赖路径上重复出现。
- Yarn 汇总的路径计数：严重 0、高危 763、中危 453、低危 79。
- 公告逐项清单及依赖路径示例见同目录的 `yarn-audit-2026-10-13.csv`。

## 命中组件

| 组件 | 命中版本 | 严重 | 高危 | 中危 | 低危 |
| --- | --- | ---: | ---: | ---: | ---: |
| minimatch | 10.1.1, 3.0.5, 3.1.2, 5.1.6, 8.0.4, 9.0.3, 9.0.5 | 0 | 15 | 0 | 0 |
| axios | 1.13.5 | 0 | 12 | 21 | 1 |
| brace-expansion | 1.1.12, 2.0.2 | 0 | 10 | 4 | 0 |
| js-yaml | 3.14.0, 3.14.1, 4.1.1 | 0 | 6 | 3 | 0 |
| basic-ftp | 5.2.0 | 0 | 5 | 0 | 0 |
| undici | 5.29.0 | 0 | 3 | 7 | 3 |
| nx | 22.2.0 | 0 | 3 | 2 | 0 |
| @grpc/grpc-js | 1.13.4 | 0 | 3 | 0 | 1 |
| nanoid | 3.3.8 | 0 | 3 | 0 | 0 |
| picomatch | 2.3.1, 4.0.2, 4.0.3 | 0 | 2 | 2 | 0 |
| postcss | 8.5.3 | 0 | 2 | 2 | 0 |
| browserslist | 4.24.4, 4.28.0 | 0 | 2 | 0 | 0 |
| flatted | 3.2.4 | 0 | 2 | 0 | 0 |
| linkify-it | 3.0.3 | 0 | 2 | 0 | 0 |
| thrift | 0.20.0 | 0 | 2 | 0 | 0 |
| toml | 3.0.0 | 0 | 2 | 0 | 0 |
| ws | 5.2.4, 7.5.10 | 0 | 2 | 0 | 0 |
| ip-address | 9.0.5 | 0 | 1 | 4 | 0 |
| joi | 17.13.3 | 0 | 1 | 2 | 2 |
| @fastify/busboy | 2.1.1 | 0 | 1 | 1 | 0 |
| fast-xml-builder | 1.1.5 | 0 | 1 | 1 | 0 |
| http-proxy-middleware | 3.0.5 | 0 | 1 | 1 | 0 |
| lodash | 4.17.23 | 0 | 1 | 1 | 0 |
| mysql2 | 3.11.5 | 0 | 1 | 1 | 0 |
| @babel/plugin-transform-modules-systemjs | 7.28.5 | 0 | 1 | 0 | 0 |
| @isaacs/brace-expansion | 5.0.0 | 0 | 1 | 0 | 0 |
| braces | 3.0.3 | 0 | 1 | 0 | 0 |
| glob | 10.4.5 | 0 | 1 | 0 | 0 |
| http-cache-semantics | 4.1.1 | 0 | 1 | 0 | 0 |
| js-cookie | 2.2.1 | 0 | 1 | 0 | 0 |
| pacote | 21.0.1, 21.0.4 | 0 | 1 | 0 | 0 |
| path-to-regexp | 0.1.12 | 0 | 1 | 0 | 0 |
| sigstore | 4.0.0 | 0 | 1 | 0 | 0 |
| source-map-js | 1.2.1 | 0 | 1 | 0 | 0 |
| tmp | 0.0.33, 0.2.3 | 0 | 1 | 0 | 1 |
| qs | 6.13.0 | 0 | 0 | 3 | 1 |
| markdown-it | 12.3.2 | 0 | 0 | 2 | 0 |
| yaml | 1.10.2, 2.4.5, 2.7.0, 2.7.1 | 0 | 0 | 2 | 0 |
| @sigstore/core | 3.0.0 | 0 | 0 | 1 | 0 |
| ajv | 6.12.6 | 0 | 0 | 1 | 0 |
| baseline-browser-mapping | 2.8.31 | 0 | 0 | 1 | 0 |
| fast-xml-parser | 4.5.6 | 0 | 0 | 1 | 0 |
| follow-redirects | 1.15.11 | 0 | 0 | 1 | 0 |
| moment | 2.30.1 | 0 | 0 | 1 | 0 |
| postcss-selector-parser | 7.1.0 | 0 | 0 | 1 | 1 |
| snowflake-sdk | 2.2.0 | 0 | 0 | 1 | 0 |
| sprintf-js | 1.0.3, 1.1.3 | 0 | 0 | 1 | 0 |
| uuid | 10.0.0, 11.1.0, 8.0.0, 8.3.2, 9.0.1 | 0 | 0 | 1 | 0 |
| @babel/core | 7.28.5 | 0 | 0 | 0 | 1 |
| @tootallnate/once | 1.1.2, 2.0.0 | 0 | 0 | 0 | 1 |
| aws-sdk | 2.1692.0 | 0 | 0 | 0 | 1 |
| body-parser | 1.20.3 | 0 | 0 | 0 | 1 |
| elliptic | 6.6.1 | 0 | 0 | 0 | 1 |
| es5-ext | 0.10.53 | 0 | 0 | 0 | 1 |

## 本轮依赖升级相关告警

- `fast-xml-builder@1.1.5` 经 `@cubejs-backend/base-driver > @azure/storage-blob > @azure/core-xml > fast-xml-parser` 引入。高危 GHSA-5wm8-gmm8-39j9 修复于 1.1.7；中危 GHSA-45c6-75p6-83cc 修复于 1.1.6。
- `fast-xml-parser@4.5.6` 仍命中中危 GHSA-gh4j-gqv2-49f6；公告给出的修复范围为 `>=5.7.0`。
- 上轮重点升级的 `form-data`、`proxy-addr`、`handlebars`、`protobufjs` 当前未命中告警；`fast-xml-parser` 仅剩上述中危。

## 计数说明

每个 Yarn 公告 ID 计一次；同一 GHSA 针对多个主版本范围可能有多个公告 ID。命中版本是审计 `findings` 中出现的版本。此报告记录审计结果，不代表所有依赖路径都会在生产环境中执行。
