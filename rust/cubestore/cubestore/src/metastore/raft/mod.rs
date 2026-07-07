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

// TODO(PoC Day 4 next steps):
//   - log_store.rs:        RaftLogStorage impl (port from openraft example, single-CF RocksDB).
//   - state_machine.rs:    RaftStateMachine impl; apply() calls db.write(wb.write_batch()).
//   - network.rs:          RaftNetwork impl (toy_rpc WebSocket, separate port, as in example).
//   - api.rs:              App + initialize / add_learner / change_membership / client_write.
//   - rocks_store.rs hook: branch in BatchPipe::batch_write_rows to route via Raft when enabled.
//   - config/mod.rs hook:  add `rocksdb-raft` branch in configure_meta_store.
