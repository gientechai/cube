# Cube Store HA 使用手册与运维手册

- **适用版本**：`feature/openraft-metastore-poc` 分支（cubestore 1.6.61 + rocksdb-raft HA）
- **读者**：交付工程师（部署）、客户运维（日常/故障）、SRE（监控/容量）
- **配套**：`README.md`（架构与快速启动）、`docker-compose.yml`、`haproxy.cfg`

---

## 目录

1. [产品能力与 SLO](#1-产品能力与-slo)
2. [部署手册](#2-部署手册)
3. [监控手册](#3-监控手册)
4. [日常运维手册](#4-日常运维手册)
5. [扩缩容手册（RB-1 / RB-2 / RB-3）](#5-扩缩容手册rb-1--rb-2--rb-3)
6. [故障处理手册](#6-故障处理手册)
7. [升级与维护手册](#7-升级与维护手册)
8. [性能与容量参考](#8-性能与容量参考)
9. [FAQ](#9-faq)

---

## 1. 产品能力与 SLO

### 1.1 能力总览

| 能力 | 说明 | 实测 |
|---|---|---|
| **控制面 HA** | metastore（表/partition/chunk 元数据）经 Raft 在 3 节点复制，quorum 2/3 | leader 宕机重选 **0.44–0.88s** |
| **数据面 HA** | 预聚合数据（Parquet）存 S3，任一存活节点可服务查询 | kill-leader 后切节点查询连续、数据一致 |
| **LB 自动摘除** | haproxy 以 `/readyz` 探活，死节点 2 秒内摘除 | 本地实证 |
| **读零开销** | metastore 读走本地 RocksDB 副本 | ~4k QPS，与无 Raft 一致 |
| **快照** | Raft snapshot 持久化（自动每 1000 条 + 手动），重启从位点恢复 | 实证 |
| **动态成员** | 运行中加/减节点（add_learner / change_membership） | RB-1/2 e2e 实证 |

### 1.2 SLO（与承诺对照）

| 指标 | SLO | 实测 |
|---|---|---|
| Router（含 metastore leader）宕机 RTO | ≤ 3s | 0.44–0.88s |
| Router 宕机 RPO | ≈ 0（已 commit 写） | ✅ |
| 计划维护查询中断 | 0（滚动，需 §7 流程） | 流程化 |
| 双活读一致性 | follower stale ≤ 1s（apply 滞后） | ✅ |
| Split-brain | 0（Raft 共识） | 机制保证 |

### 1.3 已知边界（必读）

- **failover 瞬间**进行中的那一次查询/写会失败一次，依赖客户端重试（cube.js 默认重试）
- LB 自身单点：客户侧 keepalived / 云 LB 前置
- toy_rpc（Raft 内部通信）无 mTLS：仅限内网/受信网络
- in-memory chunk（尚未落 S3 的流式数据）在归属 worker 死亡时短暂不可用（BI 预聚合场景影响极小）

---

## 2. 部署手册

### 2.1 前置清单

| 项 | 要求 |
|---|---|
| Docker + compose 插件 | 24+ |
| cubestore 镜像 | 本分支构建（见 2.4） |
| S3 bucket | 强一致实现：**Garage（首选）/ MinIO / SeaweedFS / AWS S3** |
| 节点资源 | 每容器 4C / 8GB / 50GB SSD |
| 网络 | 节点间 :22001（Raft）、:3030/:3031 互通；客户端可达 LB :3030 |

### 2.2 S3 准备（以 Garage 为例）

```bash
# 1. 起 Garage（生产用 3 副本集群，此处单节点示意）
docker run -d --name garage -p 3900:3900 ... dxflrs/garage:v1.0.1

# 2. 初始化 + 建 bucket + 建 key
docker exec garage /garage layout assign -z dc1 -c 10G <node_id>
docker exec garage /garage layout apply --version 1
docker exec garage /garage bucket create cubestore
docker exec garage /garage key create cs-key        # 记下 GK... 与 Secret
docker exec garage /garage bucket allow --read --write cubestore --key GK...
```

> 本分支已修复 Garage/MinIO 接入的两个上游 bug（S3 key 前导斜杠、DELETE 签名头），
> Garage 可直接使用；**勿使用官方上游 cube 镜像接 Garage**。

### 2.3 启动集群

```bash
cd deploy/ha
cat > .env <<EOF
S3_ENDPOINT=http://garage:3900
S3_BUCKET=cubestore
S3_ACCESS_KEY=GK...
S3_SECRET_KEY=...
S3_REGION=garage
EOF
docker compose up -d
```

### 2.4 构建镜像（交付方）

```bash
# 在本仓库根目录（镜像内为 linux release 构建，首次约 20-40 分钟）
docker build -t <registry>/cube-cubestore:ha-poc -f rust/cubestore/Dockerfile rust/cubestore
docker push <registry>/cube-cubestore:ha-poc
# 部署侧：CUBESTORE_IMAGE=<registry>/cube-cubestore:ha-poc docker compose up -d
```

### 2.5 部署验收（必做）

```bash
# 1. 三节点就绪、有 leader、applied 一致
for i in 1 2 3; do curl -s localhost:303$i/raftz; echo; done
#    预期：一个 "state":"Leader"，三者 leader 相同、last_applied 相等

# 2. Prometheus 指标可抓
curl -s localhost:3031/metrics | head

# 3. cube.js 连 LB 冒烟查询（返回正确数据即通过）

# 4. （可选，交付机房内）混沌回归
./scripts/ha-e2e.sh
```

---

## 3. 监控手册

### 3.1 端点

| 端点 | 内容 |
|---|---|
| `GET {node}:3031/raftz` | JSON：node / state / leader / term / last_log_index / last_applied / running_state_ok |
| `GET {node}:3031/metrics` | Prometheus 文本（`cubestore_raft_*`） |
| `GET {lb}:9600/stats` | haproxy 后端状态（UP/DOWN） |

### 3.2 指标与告警建议

| 指标 | 含义 | 告警建议 |
|---|---|---|
| `cubestore_raft_is_leader` | 本节点是否 leader | 三实例求和 = 0 持续 10s → **Critical：无 leader** |
| `cubestore_raft_apply_lag` | 本地 apply 落后 commit | > 100 持续 1min → Warning：复制积压 |
| `cubestore_raft_running_state_ok` | RaftCore 存活 | = 0 → Critical：节点 Raft 已 Shutdown |
| `cubestore_raft_term` | 当前任期 | 5 分钟内跳变 > 1 次 → Warning：频繁选举 |
| haproxy stats | 后端健康 | 任一后端 DOWN 未预期 → Warning |

### 3.3 日常巡检（建议每日）

```bash
# 三节点 applied 是否一致（漂移即异常）
for i in 1 2 3; do curl -s localhost:303$i/raftz | grep -o '"last_applied":[0-9]*'; done | sort -u | wc -l
# 预期输出 1
```

---

## 4. 日常运维手册

### 4.1 手动快照（维护/备份前必做）

```bash
curl -X POST <任一leader>:3031/raftz
# 日志确认："Raft snapshot built and persisted: id=..., N kv pairs"
```

### 4.2 数据备份

metastore 是**可重建缓存**（预聚合可从源库重算），纵深三层：
1. Raft 3 副本（实时，RPO=0）
2. 快照（S3 里的 metastore snapshot + Raft log，恢复见 §6.5）
3. 终极：清空 S3 + metastore，让 Cube 重建预聚合（成本=重算时间）

### 4.3 日志要点

| 关键日志 | 含义 |
|---|---|
| `Raft cluster bootstrapped / joining as member` | 节点首次组网 / 重启加入（正常） |
| `Raft snapshot built and persisted` | 快照完成（正常） |
| `Raft state machine restored from persisted snapshot` | 重启恢复（正常） |
| `Raft apply: fired N MetaStoreEvents` | 复制事件扇出（正常，debug 噪音可忽略） |
| `Raft write deferred: no leader elected yet` | 选举窗口重试（短暂出现正常） |
| `no leader elected after 60 retries` | **异常**：12 秒无 leader → §6.2 |

---

## 5. 扩缩容手册（RB-1 / RB-2 / RB-3）

> 所有成员操作**发给当前 leader**；操作前后核对 `/raftz`。

### RB-1 加节点（3 → 4）

```bash
# 1. compose 加 cubestore-n4（新 CUBESTORE_RAFT_NODE_ID=4，DATA_DIR 干净）
docker compose up -d cubestore-n4
# 2. leader 上登记 learner（等它追平日志）
curl -X POST <leader>:3031/raftz -H 'Content-Type: application/json' \
  -d '{"action":"add_learner","id":4,"rpc_addr":"cubestore-n4:22001"}'
# 3. 转正为 voter
curl -X POST <leader>:3031/raftz -H 'Content-Type: application/json' \
  -d '{"action":"change_membership","members":[1,2,3,4]}'
# 4. 验证：四节点 leader 一致、applied 收敛
```

### RB-2 减节点（4 → 3，或替换故障节点）

```bash
curl -X POST <leader>:3031/raftz -H 'Content-Type: application/json' \
  -d '{"action":"remove_member","id":4}'
# 确认成员变更后，再 docker compose down cubestore-n4 && docker volume rm ...
```

> ⚠️ 先 remove 后停容器（顺序反了会触发不必要的选举）。**3 节点集群一次只动一个**。

### RB-3 替换故障节点

```bash
# 1. 摘除故障成员
curl -X POST <leader>:3031/raftz -d '{"action":"remove_member","id":N}'
# 2. 清掉旧节点数据卷，以同 ID 重新 up（干净存储 = 全新成员）
# 3. RB-1 流程加回
```

---

## 6. 故障处理手册

### 6.1 症状速查表

| 症状 | 诊断 | 处置 |
|---|---|---|
| 查询偶发失败一次后恢复 | failover 瞬间（预期行为） | 无需处理 |
| 某节点 `/raftz` 连接拒绝 | 进程/容器死 | `docker compose ps` → 重启该节点（RB-3 若数据卷损坏） |
| 三节点都 `Candidate`/无 leader > 10s | 见 6.2 | 6.2 流程 |
| `running_state_ok:false` | RaftCore Fatal（多为存储错误） | 6.3 |
| applied 三节点漂移 | 复制中断（网络/磁盘） | 6.4 |
| S3 报 `can't be listed` | S3 一致性/凭证 | 6.6 |

### 6.2 选不出 leader

```bash
# 1. 网络互通？节点间 22001 端口 telnet 逐对测试
# 2. 多数派存活？（3 节点至少 2 个 up）
# 3. 磁盘满？df -h（RocksDB 写不进会 Fatal）
# 4. 若 2 个永久丢失（单节点存活，无 quorum）→ 最后手段（可能丢未复制日志，需审批）：
#    停全部节点；在健康度最高的节点上以 CUBESTORE_RAFT_NODES=<只含自己> 重启
#    （构成单节点集群）；其余节点清卷后按 RB-1 重新加入。
```

### 6.3 单节点 `running_state_ok:false`

该节点 RaftCore 已 Fatal（其余节点不受影响）。处置：收集日志 → 重启容器；
若反复 Fatal，清数据卷按 RB-3 重建（数据从 Raft/S3 恢复）。

### 6.4 复制积压（apply_lag 持续上涨）

按序检查：网络（22001 丢包/带宽）→ 磁盘 IO（follower 写入慢）→ S3 延迟。
持续不收敛：RB-2 摘除该节点 → RB-3 干净重建。

### 6.5 全集群恢复（DR）

```bash
# 前提：S3 可访问（数据都在）。任一节点：
docker compose down && docker volume rm <n1-data>   # 清空本地 metastore/raft log
docker compose up -d
# 节点从 S3 拉取 metastore 快照 + Raft 重放，自动恢复成员关系
```

### 6.6 S3 相关

| 报错 | 原因 | 处置 |
|---|---|---|
| `can't be listed after upload` | S3 非强一致 / 凭证错 | 换强一致实现；查 `S3_*` |
| `400`/`403` on delete | 凭证 / 权限 | bucket 授权读写 |
| Garage 特有 | 上游镜像有 bug | **必须用本分支镜像**（已修复） |

---

## 7. 升级与维护手册

### 7.1 滚动升级（单节点，依次执行，版本差 ≤ 1）

```bash
# 针对每个节点（先 follower，leader 最后）：
# 1. 维护前快照
curl -X POST <node>:3031/raftz
# 2. 更新镜像
docker compose pull cubestore-nX && docker compose up -d cubestore-nX
# 3. 等它回来：/raftz 的 applied 追平其他节点
# 4. 下一个
```

> leader 迁移：当前实现未做 leadership transfer——leader 节点重启会触发一次 <1s 选举，
> 客户端重试吸收；如需零中断，先 RB-2/RB-1 把 leader 挪到别的节点再升级它。

### 7.2 回滚

镜像 tag 回退 + 同样滚动。Raft 日志向后兼容性未做跨大版本承诺：**降级前先手动快照**，
异常时按 6.5 从 S3 重建。

---

## 8. 性能与容量参考

（release build，M1/本机基准，`raft-bench`，单进程 3 成员真实 toy_rpc 互连）

| 模式 | 写 QPS | 写 p50 | 写 p99 | 读 QPS | 读 p50 |
|---|---|---|---|---|---|
| 无 Raft | 38,065 | 24µs | 64µs | 4,071 | 242µs |
| Raft×1 | 12,973 | 67µs | 177µs | 4,087 | 242µs |
| **Raft×3（本部署）** | **3,106** | **304µs** | 763µs | **3,998** | 247µs |

- metastore 写峰值需求 ~15 QPS（GienBI 100 租户估算，v4 §13）→ **200× 余量**
- S3 容量 ≈ 预聚合数据总量 × 1.2；节点 SSD ≥ 该节点热分区 × 1.5（warmup 缓存）
- 扩容触发：`apply_lag` 持续 > 100 / 磁盘 > 80% / 写 p99 > 100ms

---

## 9. FAQ

**Q：为什么 readyz 不检查 Raft leader？**
选举窗口 <1s，若纳入检查会把所有节点同时摘出 LB，制造不必要中断。

**Q：follower 上的读会不会读到旧数据？**
可能，滞后 ≤1s（apply 延迟）。BI 元数据场景可接受；需要严格读己所写时设
`CUBESTORE_RAFT_LINEARIZABLE_READS=true`（leader 每读多一次 quorum RTT）。

**Q：可以直接扩展到 5 节点吗？**
可以（RB-1 ×2）。quorum 变 3/5，容忍 2 节点宕机。写吞吐上限不变（单 leader 复制更多副本略慢）。

**Q：Cube Store 的 worker 也在这些容器里吗？**
是。本拓扑每节点为自包含 router+worker（数据在 S3，任意节点可执行）。跨节点 worker 池为后续项。

**Q：支持哪些 S3？**
强一致实现均可：Garage（首选，本分支实测全链路通过）、MinIO、SeaweedFS、AWS S3。
注意必须使用本分支构建的镜像（含两个 S3 兼容性修复）。
