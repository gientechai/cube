# GienBI 栈 — CubeStore HA（内置 MinIO）

将原 compose 中的**单个** `cubestore` 服务替换为：**3 节点 CubeStore + haproxy + 内置 MinIO**。  
**无需**外部 MinIO / Garage / AWS S3。

## 架构

```
cubejs ──► cubestore-${PROFILE}:3030  (haproxy，容器名与原来相同)
                │
         n1 / n2 / n3  (rocksdb-raft)
                │
    cubestore-minio-${PROFILE}  (inner 网，bucket: cubestore)
```

## 1. 删除原单节点 cubestore

```yaml
  cubestore:
    image: gientechai/cubestore:v1.6.22-3.0.4-4-non-avx
    container_name: cubestore-${PROFILE}
    environment:
      CUBESTORE_REMOTE_DIR: /cube/data
    volumes:
      - /home/ubuntu/data/${PROFILE}/cubestore/data:/cube/data
```

## 2. 合并 HA 服务

**方式 A（推荐）**：直接使用完整 compose  
[docker-compose.gienbi.full.yml](./docker-compose.gienbi.full.yml) — 已含 gienbi-app / cubejs / chat-agent + HA CubeStore + 内置 MinIO。  
**haproxy 配置已内联**在 `cubestore-${PROFILE}` 的 `command` 中，容器云平台 Stack 单文件粘贴即可，**无需** `haproxy.gienbi.cfg.template`。

**方式 B**：只替换 cubestore 块  
将 [docker-compose.gienbi.yml](./docker-compose.gienbi.yml) 中的 `services` 合并进主 compose。

## 3. 环境变量

最少只需：

```env
PROFILE=test300
CUBESTORE_IMAGE=gientechai/cubestore:v1.6.61-3.3.0-ha-ha
```

无 AVX 的 x86 机器：

```env
CUBESTORE_IMAGE=gientechai/cubestore:v1.6.61-3.3.0-ha-ha-non-avx
```

MinIO 账号/bucket **已有默认值**，一般不必再配：

| 变量 | 默认值 |
|------|--------|
| `S3_ENDPOINT` | `http://cubestore-minio-${PROFILE}:9000` |
| `S3_BUCKET` | `cubestore` |
| `S3_ACCESS_KEY` | `cubestore` |
| `S3_SECRET_KEY` | `cubestore123` |

模板见 [.env.gienbi.example](./.env.gienbi.example)。

## 4. 启动前建目录

```bash
PROFILE=test300   # 换成你的 PROFILE
sudo mkdir -p /home/ubuntu/data/${PROFILE}/cubestore/{n1,n2,n3,minio}
```

## 5. cubejs — 不用改 host

```yaml
  cubejs:
    environment:
      - CUBEJS_CUBESTORE_HOST=cubestore-${PROFILE}
      - CUBEJS_CUBESTORE_PORT=3030
```

生产建议：

```yaml
      - CUBEJS_DEV_MODE=false
      - NODE_ENV=production
```

## 6. 服务清单（每个 PROFILE 一套）

| 容器 | 作用 |
|------|------|
| `cubestore-minio-${PROFILE}` | S3 存储（预聚合数据） |
| `cubestore-minio-init-${PROFILE}` | 建 bucket（跑完即 Exited 0，正常） |
| `cubestore-n1/n2/n3-${PROFILE}` | Raft 三节点 |
| `cubestore-${PROFILE}` | haproxy LB（**cubejs 连这个**） |

## 7. 验收

```bash
# Raft
docker exec cubestore-n1-${PROFILE} sh -c 'wget -qO- http://127.0.0.1:3031/raftz'

# cubejs 容器内
curl -s -o /dev/null -w "%{http_code}\n" http://cubestore-${PROFILE}:3030/
```

## 8. MinIO 控制台（可选）

如需排查 S3 数据，可在 compose 里给 `cubestore-minio-${PROFILE}` 增加：

```yaml
    ports:
      - "9001:9001"   # 控制台；9000 API 仅 inner 网，可不暴露
```

浏览器访问 `http://<host>:9001`，账号 `cubestore` / `cubestore123`。
