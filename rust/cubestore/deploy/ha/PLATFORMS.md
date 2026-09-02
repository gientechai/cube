# 平台部署指引：Swarm / Portainer（GienBI P6）与 cs-ha-agent 说明

## 1. Docker Swarm（同一份 compose）

`deploy/ha/docker-compose.yml` 可直接作为 stack 使用（v4 §5"标准 LB 健康检查、单 bundle、
流量切换零分叉"）：

```bash
docker stack deploy -c <(docker compose -f deploy/ha/docker-compose.yml convert) cubestore-ha
```

注意：
- Swarm 的 DNS 服务发现提供 `cubestore-n1/2/3` 名称，Raft 静态成员表无需改动
- haproxy 容器在 Swarm 下可换成 Swarm 内置 VIP（`endpoint_mode: vip`），
  但保留 haproxy 可获得与 compose/k8s 完全一致的健康检查语义（推荐保留）

## 2. Portainer（GienBI 内网交付标准路径）

GienBI 客户环境用 Portainer Stacks 部署本单元：

1. **镜像**：`ghcr.io/gientechai/cube-cubestore:ha-poc`（由 `ha-image.yml` 流水线产出；
   离线环境从流水线导出 tar，Portainer 导入本地 registry 或直接 `docker load`）
2. **Stack 配置**：Portainer → Stacks → New stack → Repository，指向本仓库
   `rust/cubestore/deploy/ha/`，compose 文件选 `docker-compose.yml`
3. **环境变量**（Portainer Stack 的 Env 页签）：
   ```
   CUBESTORE_IMAGE=<镜像地址>
   S3_ENDPOINT=http://<garage-or-minio>:3900
   S3_BUCKET=cubestore
   S3_ACCESS_KEY=***
   S3_SECRET_KEY=***
   S3_REGION=garage
   ```
4. **网络**：将 stack 加入 GienBI `inner` 网络（与 cubejs/nacos 同网段），
   不依赖外部 nacos——Raft 走容器名直连
5. **cube.js 接入**（Portainer 里 cubejs 服务的环境变量）：
   ```
   CUBEJS_CUBESTORE_HOST=cubestore-lb
   CUBEJS_CUBESTORE_PORT=3030
   ```
6. **验收**：按 OPERATIONS.md §2.5 四步（/raftz 一致性、/metrics、冒烟查询、ha-e2e）

## 3. cs-ha-agent / supervisor（现状说明）

v4 §4 的 L1 基线层规划了 cs-ha-agent（tini 托管 agent + supervisor 的单 bundle）。
**当前 compose/k8s 拓扑下其职责已被平台原生机能覆盖**，故未实现：

| v4 设想职责 | 现由谁承担 |
|---|---|
| 进程守护/自愈 | compose `restart: unless-stopped` / k8s kubelet+liveness |
| 健康检查摘流 | haproxy `/readyz` / k8s readinessProbe |
| 快照定时 | Cube Store 内置 `LogsSinceLast(1000)` 自动快照 + `POST /raftz` 手动 |
| 优雅停机 | k8s preStop/drain（滚动升级流程见 OPERATIONS §7） |

**何时需要真正的 agent**：VM 裸机部署（无 docker/k8s）、或需要"节点级"自愈策略
（磁盘清理、日志轮转、S3 凭证轮换）时再引入——当前 Portainer/compose 交付不阻塞。

## 4. 档位与容量（摘自 OPERATIONS §8，完整见手册）

| 档位 | 拓扑 | 容忍 |
|---|---|---|
| 最小 HA | 2 节点 + LB | 1 节点 |
| 标准（默认 compose） | 3 节点 + LB | 1 节点 |
| 高可用 | 5 节点 + LB | 2 节点 |

写吞吐参考：Raft3 实测 3106 QPS（p50 304µs），需求峰值 ~15 QPS，200× 余量。
