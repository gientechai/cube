# Cube Store HA — 部署单元（v4 P3 最小切片）

3 节点 `rocksdb-raft` 集群 + S3 数据面 + haproxy VIP 的可交付部署单元。

## 架构

```
cube.js ── CUBEJS_CUBESTORE_HOST=cubestore-lb:3030
                     │ (ws / http)
              ┌──────▼──────┐
              │   haproxy   │  /readyz 健康检查（status :3031，1s×2 摘除）
              └──┬────┬────┬─┘
       ┌─────────┘    │    └─────────┐
  cubestore-n1   cubestore-n2   cubestore-n3     ← rocksdb-raft 静态 3 成员
       │              │              │               （toy_rpc :22001 互连）
       └──────────────┼──────────────┘
                      ▼
              S3 bucket（Garage / MinIO / SeaweedFS / AWS）
              （Parquet chunk + metastore 快照，所有节点共享）
```

- **控制面 HA**：metastore 写经 Raft 复制（quorum 2/3），leader 挂 → <1s 重选（实测 0.44-0.88s）
- **数据面 HA**：所有文件在 S3；任一存活节点可服务查询（kill-leader 后切节点查询连续性已 e2e 实证）
- **读零开销**：metastore 读走本地 RocksDB（release 实测三模式均 ~4k QPS）
- **写开销**：Raft3 写 3106 QPS / p50 304µs——对 metastore 写峰值 ~15 QPS 有 200× 余量

## 前置条件

1. **cubestore 镜像**：从本分支构建并推送，设置 `CUBESTORE_IMAGE`（默认 `ghcr.io/gientechai/cube-cubestore:ha-poc`）
2. **S3 bucket**：任何强一致 S3 兼容存储（Garage 首选，MinIO/SeaweedFS/AWS 亦可；本分支已修复 Garage/MinIO 接入 bug），填充 `.env`：
   ```
   S3_ENDPOINT=http://garage:3900     # 或 https://s3.<region>.amazonaws.com
   S3_BUCKET=cubestore
   S3_ACCESS_KEY=...
   S3_SECRET_KEY=...
   S3_REGION=garage
   ```

## 启动

```bash
cd deploy/ha
docker compose up -d
docker compose ps
# 观察 Raft 集群状态（任一节点）：
curl http://127.0.0.1:3031/raftz          # JSON：node/state/leader/term/applied
curl http://127.0.0.1:3031/metrics        # Prometheus 文本格式
```

## cube.js 接入（零代码改动）

```env
CUBEJS_CUBESTORE_HOST=cubestore-lb
CUBEJS_CUBESTORE_PORT=3030
```

failover 期间进行中的那一次查询会失败一次，依赖客户端重试（cube.js 默认重试 60 次）。

## 运维（Runbook 速查）

| 操作 | 命令 |
|---|---|
| 集群状态 | `curl :3031/raftz`（leader/term/applied；三节点 applied 应相等） |
| Prometheus 指标 | `curl :3031/metrics`（`cubestore_raft_*` 系列） |
| 手动快照（维护前） | `curl -X POST :3031/raftz` |
| 加节点（RB-1） | `curl -X POST <leader>:3031/raftz -d '{"action":"add_learner","id":4,"rpc_addr":"cubestore-n4:22001"}'` 然后 `change_membership` |
| 减节点（RB-2） | `curl -X POST <leader>:3031/raftz -d '{"action":"remove_member","id":N}'` |
| 混沌回归 | `rust/cubestore/scripts/ha-e2e.sh`（选主/快照/kill-leader SLO/RB-1/2/一致性） |
| 性能回归 | `BENCH_MODE=raft3 cargo run --release --bin raft-bench` |

## 客户档位（v4 §6）

| 档位 | 拓扑 | 说明 |
|---|---|---|
| 最小 HA | 2 router + 2 worker（本 compose 的 2 副本裁剪） | 容忍 1 节点 |
| 标准 | **本 compose（3 + LB）** | 容忍 1 节点，推荐起步 |
| 高可用 | 5 router + 3-5 worker | 容忍 2 节点 |

节点规格：4C/8GB/50GB SSD（router）；S3 容量 ≈ 预聚合数据总量 × 1.2。

## 已知边界

- 滚动升级尚未实现 drain/leadership transfer（v4 §11）：维护时先 `POST /raftz` 触发快照再停节点
- LB 自身 HA 是客户责任（keepalived/云 LB 前置）
- toy_rpc 无 mTLS（内网部署假设；v4 预留扩展点）
