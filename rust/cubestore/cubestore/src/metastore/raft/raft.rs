//! toy_rpc service exposing Raft RPC endpoints (vote / append / snapshot) to
//! peer nodes over WebSocket. Ported from openraft example `src/network/raft.rs`.

use std::sync::Arc;

use openraft::raft::AppendEntriesRequest;
use openraft::raft::AppendEntriesResponse;
use openraft::raft::InstallSnapshotRequest;
use openraft::raft::InstallSnapshotResponse;
use openraft::raft::VoteRequest;
use openraft::raft::VoteResponse;
use toy_rpc::macros::export_impl;

use crate::metastore::raft::app::App;
use crate::metastore::raft::CubeStoreRaftTypeConfig;

/// Raft protocol service served over toy_rpc (WebSocket).
pub struct RaftService {
    pub app: Arc<App>,
}

impl RaftService {
    pub fn new(app: Arc<App>) -> Self {
        Self { app }
    }
}

#[export_impl]
impl RaftService {
    #[export_method]
    pub async fn vote(&self, vote: VoteRequest<u64>) -> Result<VoteResponse<u64>, toy_rpc::Error> {
        self.app.raft.vote(vote).await.map_err(|e| toy_rpc::Error::Internal(Box::new(e)))
    }

    #[export_method]
    pub async fn append(
        &self,
        req: AppendEntriesRequest<CubeStoreRaftTypeConfig>,
    ) -> Result<AppendEntriesResponse<u64>, toy_rpc::Error> {
        self.app.raft.append_entries(req).await.map_err(|e| toy_rpc::Error::Internal(Box::new(e)))
    }

    #[export_method]
    pub async fn snapshot(
        &self,
        req: InstallSnapshotRequest<CubeStoreRaftTypeConfig>,
    ) -> Result<InstallSnapshotResponse<u64>, toy_rpc::Error> {
        self.app.raft.install_snapshot(req).await.map_err(|e| toy_rpc::Error::Internal(Box::new(e)))
    }
}
