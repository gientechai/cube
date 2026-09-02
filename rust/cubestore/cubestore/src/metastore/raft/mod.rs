//! CubeStore metastore HA via embedded OpenRaft (PoC Day 4).
//!
//! Replicates `WriteBatchContainer` — the *same* serializable batch CubeStore
//! already uses for WAL upload (`rocks_store.rs:1154`) — across router nodes via
//! Raft. Each node applies the batch to its local RocksDB via
//! `db.write(container.write_batch())`, converging the cluster to byte-identical
//! metastore state. This makes the metastore active-active (leader-write +
//! follower-read + hot-failover) without any external DB.
//!
//! See `docs/superpowers/specs/2026-07-07-openraft-metastore-poc-plan.md` for
//! the design and Day 1-2 + R5 validation results.

use std::fmt::Display;
use std::io::Cursor;
use std::sync::Arc;

use self::raft::RaftServiceClientStub;

use openraft::Raft;
use serde::Deserialize;
use serde::Serialize;

use crate::metastore::rocks_store::WriteBatchContainer;

pub type NodeId = u64;

/// Node identity carried in Raft membership: `rpc_addr` (Raft + CubeStore cluster
/// transport) and `api_addr` (CubeStore HTTP/WS / management).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Node {
    pub rpc_addr: String,
    pub api_addr: String,
}

impl Display for Node {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Node {{ rpc_addr: {}, api_addr: {} }}", self.rpc_addr, self.api_addr)
    }
}

/// Raft entry payload — CubeStore's existing serializable WriteBatch.
/// Reuses `WriteBatchContainer` (rocks_store.rs:549), which already derives
/// Serialize/Deserialize/Clone. Apply on each node rebuilds a `rocksdb::WriteBatch`
/// via `container.write_batch()` and commits to local RocksDB.
pub type Request = WriteBatchContainer;

/// Apply response. CubeStore metastore writes don't need a business return value
/// through Raft (the writer already knows what it wrote); we return a unit struct
/// to satisfy openraft's `R: AppDataResponse` (Serialize + Deserialize + Clone + Debug).
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Response;

openraft::declare_raft_types!(
    pub CubeStoreRaftTypeConfig:
        D = Request,
        R = Response,
        Node = Node,
);

/// Convenience alias for the Raft instance type.
pub type CubeStoreRaft = Raft<CubeStoreRaftTypeConfig>;

/// Live Raft metrics watch channel (clone of `raft.metrics()`). `borrow()` on
/// any receiver returns the current `RaftMetrics` snapshot without awaiting.
pub type RaftMetricsChannel =
    tokio::sync::watch::Receiver<openraft::metrics::RaftMetrics<NodeId, Node>>;

/// Alias matching openraft example's `typ::Entry` (avoids a separate typ module).
pub type Entry = openraft::Entry<CubeStoreRaftTypeConfig>;

pub mod app;
pub mod log_store;
pub mod network;
pub mod raft;
pub mod state_machine;

pub use app::App;
pub use log_store::LogStore;
pub use network::{Network, NetworkConnection};
pub use raft::RaftService;
pub use state_machine::StateMachineStore;

/// Parse static cluster membership from `CUBESTORE_RAFT_NODES`, e.g.
/// `1@10.0.0.1:22001,2@10.0.0.2:22001,3@10.0.0.3:22001`. Each entry is
/// `node_id@rpc_addr`. `api_addr` is filled with `rpc_addr` — it is only
/// consumed by ForwardToLeader responses, which are not wired up yet.
pub fn parse_raft_members(spec: &str) -> Result<std::collections::BTreeMap<NodeId, Node>, String> {
    let mut nodes = std::collections::BTreeMap::new();
    for entry in spec.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let (id, rpc) = entry.split_once('@').ok_or_else(|| {
            format!("invalid CUBESTORE_RAFT_NODES entry '{entry}' (expected 'node_id@host:port')")
        })?;
        let id: NodeId = id
            .trim()
            .parse()
            .map_err(|_| format!("invalid node id '{id}' in CUBESTORE_RAFT_NODES entry '{entry}'"))?;
        let rpc = rpc.trim().to_string();
        if rpc.is_empty() {
            return Err(format!("empty rpc addr in CUBESTORE_RAFT_NODES entry '{entry}'"));
        }
        nodes.insert(id, Node { rpc_addr: rpc.clone(), api_addr: rpc });
    }
    if nodes.is_empty() {
        return Err("CUBESTORE_RAFT_NODES is set but contains no members".to_string());
    }
    Ok(nodes)
}

/// Idempotent cluster bootstrap (v4 Phase P1).
///
/// With `CUBESTORE_RAFT_NODES` unset this bootstraps a single-node cluster.
/// With it set, every node attempts to bootstrap the same static voter set:
/// the first node to start wins; the others get `InitializeError::NotAllowed`
/// and simply join as members of the already-formed cluster.
///
/// Mismatched `CUBESTORE_RAFT_NODES` values across nodes are an operator
/// error and can form two independent clusters — they are not detected here.
pub async fn bootstrap_cluster(app: &App) -> Result<(), crate::CubeError> {
    let members = match std::env::var("CUBESTORE_RAFT_NODES") {
        Ok(spec) => parse_raft_members(&spec).map_err(crate::CubeError::internal)?,
        Err(_) => {
            let mut nodes = std::collections::BTreeMap::new();
            nodes.insert(
                app.id,
                Node { rpc_addr: app.rpc_addr.clone(), api_addr: app.api_addr.clone() },
            );
            nodes
        }
    };

    match app.initialize_with(members).await {
        Ok(()) => tracing::info!(node_id = app.id, "Raft cluster bootstrapped"),
        Err(openraft::error::RaftError::APIError(
            openraft::error::InitializeError::NotAllowed(_),
        )) => tracing::info!(node_id = app.id, "Raft cluster already initialized; joining as member"),
        Err(e) => return Err(crate::CubeError::internal(format!("Raft initialize failed: {e:?}"))),
    }
    Ok(())
}

/// Propose a metastore WriteBatch through Raft, with ForwardToLeader handling
/// and cold-start tolerance (v4 §3.1, P2):
///
/// - If this node is the leader, the write commits via local `client_write`.
/// - If another node is the leader (`ForwardToLeader` with a known node), the
///   batch is replayed on the leader over toy_rpc (`RaftService::client_write`),
///   so writes accepted by any router eventually commit.
/// - While no leader is elected yet (e.g. cluster cold start), the write is
///   retried for a bounded window — Raft elections complete in well under a
///   second, but process startup ordering is not guaranteed.
pub async fn write_via_raft(
    app: &Arc<App>,
    container: WriteBatchContainer,
) -> Result<openraft::raft::ClientWriteResponse<CubeStoreRaftTypeConfig>, crate::CubeError> {
    const RETRIES: usize = 60;
    const RETRY_INTERVAL_MS: u64 = 200;

    for attempt in 0..=RETRIES {
        match app.client_write(container.clone()).await {
            Ok(resp) => {
                // Wait until THIS node applied the committed entry. Raft commit
                // (quorum replication) returns before the local state machine
                // applies, and callers read back what they wrote (e.g. job
                // scheduling immediately after CREATE TABLE) — without this
                // wait those reads hit the pre-write state (e2e-verified:
                // "Row with id 1 is not found for TableRocksTable").
                let index = resp.log_id.index;
                wait_local_applied(app, index).await?;
                return Ok(resp)
            }
            Err(openraft::error::RaftError::APIError(
                openraft::error::ClientWriteError::ForwardToLeader(f),
            )) => {
                if let Some(node) = f.leader_node {
                    let resp = forward_write_to_leader(&node, container).await?;
                    let index = resp.log_id.index;
                    wait_local_applied(app, index).await?;
                    return Ok(resp);
                }
                tracing::info!(
                    node_id = app.id,
                    attempt,
                    "Raft write deferred: no leader elected yet, retrying"
                );
                tokio::time::sleep(std::time::Duration::from_millis(RETRY_INTERVAL_MS)).await;
            }
            Err(e) => {
                return Err(crate::CubeError::internal(format!("Raft client_write failed: {e:?}")))
            }
        }
    }
    Err(crate::CubeError::internal(format!(
        "Raft client_write: no leader elected after {} retries (~{}s)",
        RETRIES,
        RETRIES as u64 * RETRY_INTERVAL_MS / 1000
    )))
}

async fn wait_local_applied(app: &Arc<App>, index: u64) -> Result<(), crate::CubeError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let applied = app
            .raft
            .metrics()
            .borrow()
            .last_applied
            .map(|l| l.index)
            .unwrap_or(0);
        if applied >= index {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(crate::CubeError::internal(format!(
                "Raft apply lag: index {index} not applied locally within 10s (applied={applied})"
            )));
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
}

async fn forward_write_to_leader(
    node: &Node,
    container: WriteBatchContainer,
) -> Result<openraft::raft::ClientWriteResponse<CubeStoreRaftTypeConfig>, crate::CubeError> {
    let addr = format!("ws://{}", node.rpc_addr);
    let client = toy_rpc::Client::dial_websocket(&addr).await.map_err(|e| {
        crate::CubeError::internal(format!(
            "Raft forward: dial leader {} failed: {e:?}",
            node.rpc_addr
        ))
    })?;
    let raft = client.raft_service();
    raft.client_write(container).await.map_err(|e| {
        crate::CubeError::internal(format!(
            "Raft forward: write via leader {} failed: {e:?}",
            node.rpc_addr
        ))
    })
}

// Remaining HA work (beyond the P0 PoC and the P1 wiring above):
//   - P2: ForwardToLeader handling in BatchPipe::batch_write_rows so writes
//     accepted by a follower are forwarded to the leader (v4 §3.1).
//   - P2: MetaStoreEvent fan-out — WriteBatchContainer should carry event
//     metadata so state_machine::apply can fire events on followers too.
//   - P4: snapshot persistence (RocksDB Checkpoint + upload_check_point)
//     instead of the in-memory JSON dump; get_current_snapshot returns None.
//   - P4: Raft metrics exposure (raft.metrics() → /metrics, v4 §8).
