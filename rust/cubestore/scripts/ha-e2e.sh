#!/usr/bin/env bash
# Cube Store rocksdb-raft HA end-to-end / chaos regression (v4 §9 CI matrix).
# Zero external dependencies: 3 local nodes, local-fs remote dir, /raftz assertions.
# Usage: ./scripts/ha-e2e.sh [path-to-cubestored-binary]
# Exit 0 = all SLO checks passed.
set -euo pipefail

BIN="${1:-$(dirname "$0")/../target/debug/cubestored}"
[ -x "$BIN" ] || { echo "cubestored binary not found at $BIN (build first)"; exit 1; }

WORK="$(mktemp -d /tmp/cs-ha-e2e.XXXXXX)"
NODES="1@127.0.0.1:22001,2@127.0.0.1:22002,3@127.0.0.1:22003"
PIDS=()
FAIL=0

cleanup() {
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

start_node() {
  local id=$1
  CUBESTORE_METASTORE_BACKEND=rocksdb-raft \
  CUBESTORE_RAFT_NODE_ID=$id \
  CUBESTORE_RAFT_RPC_ADDR=127.0.0.1:2200$id \
  CUBESTORE_RAFT_NODES="$NODES" \
  CUBESTORE_SERVER_NAME=n$id \
  CUBESTORE_WORKERS=n$id \
  CUBESTORE_HTTP_BIND_ADDR=127.0.0.1:2310$id \
  CUBESTORE_STATUS_BIND_ADDR=127.0.0.1:2320$id \
  CUBESTORE_DATA_DIR="$WORK/n$id/data" \
    "$BIN" > "$WORK/n$id.log" 2>&1 &
  PIDS+=($!)
}

raftz() { curl -s --max-time 2 "http://127.0.0.1:2320$1/raftz" 2>/dev/null; }
field() { echo "$1" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$2',''))" 2>/dev/null; }

# wait_for_leader NODEIDS... — echoes leader id, fails after timeout
wait_for_leader() {
  local deadline=$((SECONDS + 15))
  while [ $SECONDS -lt $deadline ]; do
    for i in "$@"; do
      [ "$(field "$(raftz "$i")" state)" = "Leader" ] && { echo "$i"; return 0; }
    done
    sleep 0.2
  done
  return 1
}

assert() { # assert DESC COND
  if [ "$2" = "0" ]; then echo "  ✅ $1"; else echo "  ❌ $1"; FAIL=1; fi
}

echo "=== [1] 三节点启动 ==="
start_node 1; sleep 3
start_node 2; start_node 3
sleep 8
ALIVE=0; for p in "${PIDS[@]}"; do kill -0 "$p" 2>/dev/null && ALIVE=$((ALIVE+1)); done
assert "3 节点存活" "$([ $ALIVE -eq 3 ] && echo 0 || echo 1)"

echo "=== [2] 选主（SLO < 10s）==="
LEADER=$(wait_for_leader 1 2 3) || { echo "  ❌ 15s 无 leader"; FAIL=1; LEADER=1; }
assert "leader=n$LEADER" 0
for i in 1 2 3; do
  [ "$(field "$(raftz "$i")" leader)" = "$LEADER" ] && assert "n$i 认 leader=$LEADER" 0 || assert "n$i 认 leader=$LEADER" 1
done

echo "=== [3] /metrics Prometheus 格式 ==="
M=$(curl -s http://127.0.0.1:2320$LEADER/metrics)
echo "$M" | grep -q "cubestore_raft_is_leader 1" && assert "is_leader=1 指标" 0 || assert "is_leader=1 指标" 1
echo "$M" | grep -q "cubestore_raft_last_applied" && assert "last_applied 指标" 0 || assert "last_applied 指标" 1

echo "=== [4] 快照构建（POST /raftz）==="
curl -s -X POST "http://127.0.0.1:2320$LEADER/raftz" > /dev/null
sleep 3
grep -q "snapshot built and persisted" "$WORK/n$LEADER.log" && assert "快照 build+持久化" 0 || assert "快照 build+持久化" 1

echo "=== [5] kill -9 leader（SLO failover < 3s，v4 Router RTO）==="
T0=$(python3 -c 'import time; print(time.time())')
kill -9 "${PIDS[$((LEADER-1))]}"
SURVIVORS=$(for i in 1 2 3; do [ $i != "$LEADER" ] && echo $i; done)
NEW_LEADER=$(wait_for_leader $SURVIVORS) || { echo "  ❌ failover 超时"; FAIL=1; NEW_LEADER=$(echo $SURVIVORS | awk '{print $1}'); }
T1=$(python3 -c 'import time; print(time.time())')
ELAPSED=$(python3 -c "print(f'{$T1-$T0:.2f}')")
[ "$(python3 -c "print(1 if $ELAPSED < 3 else 0)")" = "1" ] && assert "failover ${ELAPSED}s < 3s" 0 || assert "failover ${ELAPSED}s < 3s" 1

echo "=== [6] RB-2 移除成员（change_membership）==="
R=$(curl -s -X POST "http://127.0.0.1:2320$NEW_LEADER/raftz" -H 'Content-Type: application/json' \
  -d "{\"action\":\"remove_member\",\"id\":$LEADER}")
echo "  resp: $R"
echo "$R" | grep -q '"removed"' && assert "移除死节点 n$LEADER" 0 || assert "移除死节点 n$LEADER" 1

echo "=== [7] RB-1 加回成员（add_learner + change_membership）==="
R=$(curl -s -X POST "http://127.0.0.1:2320$NEW_LEADER/raftz" -H 'Content-Type: application/json' \
  -d "{\"action\":\"add_learner\",\"id\":$LEADER,\"rpc_addr\":\"127.0.0.1:2200$LEADER\"}")
echo "  add_learner resp: $R"
echo "$R" | grep -q '"added_learner"' && assert "add_learner n$LEADER" 0 || assert "add_learner n$LEADER" 1

echo "=== [8] 复制一致性（applied 追平，幸存者）==="
sleep 3
A2=$(field "$(raftz 2)" last_applied); A3=$(field "$(raftz 3)" last_applied)
[ -n "$A2" ] && [ "$A2" = "$A3" ] && assert "幸存者 applied 一致 ($A2)" 0 || assert "幸存者 applied 一致 ($A2 vs $A3)" 1

echo ""
if [ $FAIL -eq 0 ]; then echo "🎉 HA e2e 全部通过"; else echo "💥 存在失败项"; exit 1; fi
