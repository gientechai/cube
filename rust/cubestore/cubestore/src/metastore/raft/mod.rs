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

// TODO(PoC Day 4 remaining):
//   - rocks_store.rs hook: branch in BatchPipe::batch_write_rows to route via Raft when enabled.
//   - config/mod.rs hook:  add `rocksdb-raft` branch in configure_meta_store.
//   - node startup:        construct App + Raft at router init, serve toy_rpc WebSocket.
