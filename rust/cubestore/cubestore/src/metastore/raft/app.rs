//! App — holds the Raft instance + node identity, exposes cluster ops.
//!
//! Ported from openraft example `src/app.rs`. CubeStore integration: this App
//! is constructed at router-node startup (PoC step 6, in configure_meta_store /
//! cluster init) and the Raft instance is wired into the metastore write path
//! (PoC step 5, BatchPipe hook).

use std::collections::BTreeMap;
use std::sync::Arc;

use openraft::Config;
use tokio::net::TcpListener;
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

    /// Bootstrap the cluster with an explicit voter set (static membership,
    /// e.g. parsed from `CUBESTORE_RAFT_NODES`). Only takes effect on a
    /// pristine node; once the cluster is formed, later calls return
    /// `InitializeError::NotAllowed`, which callers treat as "already joined".
    pub async fn initialize_with(
        &self,
        nodes: BTreeMap<NodeId, Node>,
    ) -> Result<(), openraft::error::RaftError<NodeId, openraft::error::InitializeError<NodeId, Node>>> {
        self.raft.initialize(nodes).await
    }

    /// Serve the Raft RPC endpoint on `self.rpc_addr` (toy_rpc over WebSocket)
    /// so peer nodes can send vote / append_entries / install_snapshot
    /// requests to this node. Runs on a background task; binding failure is
    /// fatal because a Raft node without an inbound endpoint cannot form a
    /// cluster.
    pub async fn serve_raft_rpc(self: &Arc<Self>) -> std::io::Result<()> {
        let service = Arc::new(crate::metastore::raft::RaftService::new(self.clone()));
        let server = toy_rpc::Server::builder().register(service).build();

        let listener = TcpListener::bind(&self.rpc_addr).await?;
        let bind_addr = self.rpc_addr.clone();
        tokio::task::spawn(async move {
            if let Err(e) = server.accept_websocket(listener).await {
                tracing::error!("Raft RPC server on {} stopped: {}", bind_addr, e);
            }
        });
        tracing::info!("Raft RPC server listening on ws://{}", self.rpc_addr);
        Ok(())
    }
}
