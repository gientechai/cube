//! App — holds the Raft instance + node identity, exposes cluster ops.
//!
//! Ported from openraft example `src/app.rs`. CubeStore integration: this App
//! is constructed at router-node startup (PoC step 6, in configure_meta_store /
//! cluster init) and the Raft instance is wired into the metastore write path
//! (PoC step 5, BatchPipe hook).

use std::sync::Arc;

use openraft::Config;
use tokio::runtime::Handle;

use crate::metastore::raft::{CubeStoreRaft, CubeStoreRaftTypeConfig, Node, NodeId, Request};

/// Application / node-level state shared across handlers.
pub struct App {
    pub id: NodeId,
    pub rpc_addr: String,
    pub api_addr: String,
    pub tokio_handle: Handle,
    pub raft: CubeStoreRaft,
    pub config: Arc<Config>,
}

impl App {
    /// Propose a WriteBatchContainer to the Raft cluster. On commit, every node
    /// applies it to its local metastore RocksDB (see `state_machine::apply`).
    ///
    /// This is what the BatchPipe hook (PoC step 5) calls instead of
    /// `db.write(write_batch)` when Raft mode is enabled.
    pub async fn client_write(
        &self,
        req: Request,
    ) -> Result<
        openraft::raft::ClientWriteResponse<CubeStoreRaftTypeConfig>,
        openraft::error::RaftError<NodeId, openraft::error::ClientWriteError<NodeId, Node>>,
    > {
        self.raft.client_write(req).await
    }

    /// Bootstrap a single-node cluster with this node as the only voter.
    pub async fn initialize(
        &self,
    ) -> Result<(), openraft::error::RaftError<NodeId, openraft::error::InitializeError<NodeId, Node>>>
    {
        let mut nodes = std::collections::BTreeMap::new();
        nodes.insert(
            self.id,
            Node { rpc_addr: self.rpc_addr.clone(), api_addr: self.api_addr.clone() },
        );
        self.raft.initialize(nodes).await
    }
}
