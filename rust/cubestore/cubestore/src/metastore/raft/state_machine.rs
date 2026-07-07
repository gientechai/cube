//! RaftStateMachine impl — the Raft state machine IS the metastore RocksDB.
//!
//! apply() receives `Request = WriteBatchContainer` (cube's existing serializable
//! batch), rebuilds a `rocksdb::WriteBatch` via `container.write_batch()` and
//! commits to the local metastore DB. Leader + every follower apply the SAME
//! batch → cluster converges to byte-identical metastore state.
//!
//! At PoC wiring time the `Arc<DB>` handed to [`StateMachineStore::new`] is the
//! metastore RocksDB (the one [`crate::metastore::rocks_store::RocksStore`] holds);
//! apply then drives exactly what `BatchPipe::batch_write_rows` does today.
//!
//! Ported from openraft v0.9.24 example, adapted to CubeStoreRaftTypeConfig +
//! CubeStore's WriteBatchContainer + cube metastore default-CF model.

use std::io::Cursor;
use std::sync::Arc;

use openraft::storage::RaftStateMachine;
use openraft::storage::Snapshot;
use openraft::EntryPayload;
use openraft::LogId;
use openraft::RaftSnapshotBuilder;
use openraft::SnapshotMeta;
use openraft::StorageError;
use openraft::StorageIOError;
use openraft::StoredMembership;
use cuberockstore::rocksdb::{self, DB};
use serde::Deserialize;
use serde::Serialize;

use crate::metastore::raft::Entry;
use crate::metastore::raft::NodeId;
use crate::metastore::raft::Node;
use crate::metastore::raft::Response;
use crate::metastore::raft::CubeStoreRaftTypeConfig;
use crate::metastore::rocks_store::WriteBatchContainer;

type StorageResult<T> = Result<T, StorageError<NodeId>>;

#[derive(Debug, Clone)]
pub struct StateMachineData {
    pub last_applied_log_id: Option<LogId<NodeId>>,
    pub last_membership: StoredMembership<NodeId, Node>,
}

#[derive(Debug, Clone)]
pub struct StateMachineStore {
    pub data: StateMachineData,
    /// Globally-unique snapshot id suffix. Use a microsecond timestamp in production.
    snapshot_idx: u64,
    /// The metastore RocksDB. apply() commits WriteBatchContainers here.
    db: Arc<DB>,
}

/// On-disk snapshot representation (stored under the `raft_sm` key in `store` CF).
/// The data blob is a serialized `Vec<(key, value)>` dump of the metastore default CF.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct StoredSnapshot {
    meta: SnapshotMeta<NodeId, Node>,
    data: Vec<u8>,
}

impl StateMachineStore {
    /// Construct with the metastore RocksDB handle. If a prior Raft snapshot is
    /// persisted in the DB, the state machine is restored from it.
    pub async fn new(db: Arc<DB>) -> Self {
        let sm = Self {
            data: StateMachineData {
                last_applied_log_id: None,
                last_membership: Default::default(),
            },
            snapshot_idx: 0,
            db,
        };
        // TODO(PoC): restore last_applied/last_membership from persisted snapshot meta
        // before returning. For the first-cut port we start clean; snapshot persistence
        // is wired together with build_snapshot / install_snapshot below.
        sm
    }
}

impl RaftSnapshotBuilder<CubeStoreRaftTypeConfig> for StateMachineStore {
    async fn build_snapshot(&mut self) -> Result<Snapshot<CubeStoreRaftTypeConfig>, StorageError<NodeId>> {
        let last_applied_log = self.data.last_applied_log_id;
        let last_membership = self.data.last_membership.clone();

        // Dump the entire metastore default CF as (key, value) pairs.
        // PoC: acceptable for small metastore; production should use RocksDB
        // Checkpoint (cube already has upload_check_point machinery).
        let mut kvs: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        let iter = self.db.iterator(rocksdb::IteratorMode::Start);
        for item in iter {
            let (k, v) = item.map_err(|e| StorageError::IO {
                source: StorageIOError::read_state_machine(&e),
            })?;
            kvs.push((k.to_vec(), v.to_vec()));
        }
        let data_bytes =
            serde_json::to_vec(&kvs).map_err(|e| StorageIOError::read_state_machine(&e))?;

        let snapshot_id = if let Some(last) = last_applied_log {
            format!("{}-{}-{}", last.leader_id, last.index, self.snapshot_idx)
        } else {
            format!("--{}", self.snapshot_idx)
        };

        let meta = SnapshotMeta { last_log_id: last_applied_log, last_membership, snapshot_id };

        Ok(Snapshot { meta, snapshot: Box::new(Cursor::new(data_bytes)) })
    }
}

impl RaftStateMachine<CubeStoreRaftTypeConfig> for StateMachineStore {
    type SnapshotBuilder = Self;

    async fn applied_state(
        &mut self,
    ) -> Result<(Option<LogId<NodeId>>, StoredMembership<NodeId, Node>), StorageError<NodeId>> {
        Ok((self.data.last_applied_log_id, self.data.last_membership.clone()))
    }

    async fn apply<I>(&mut self, entries: I) -> Result<Vec<Response>, StorageError<NodeId>>
    where
        I: IntoIterator<Item = Entry> + openraft::OptionalSend,
        I::IntoIter: openraft::OptionalSend,
    {
        let mut replies = Vec::new();
        for ent in entries {
            self.data.last_applied_log_id = Some(ent.log_id);
            match ent.payload {
                EntryPayload::Blank => {}
                EntryPayload::Normal(req) => {
                    // `req: Request = WriteBatchContainer`. Apply atomically to local
                    // metastore RocksDB — the same `db.write(write_batch)` that
                    // BatchPipe::batch_write_rows performs today, now driven by Raft
                    // on every node. All replicas converge byte-identically.
                    let wb: WriteBatchContainer = req;
                    self.db.write(wb.write_batch()).map_err(|e| StorageError::IO {
                        source: StorageIOError::write_state_machine(&e),
                    })?;
                }
                EntryPayload::Membership(mem) => {
                    self.data.last_membership = StoredMembership::new(Some(ent.log_id), mem);
                }
            }
            replies.push(Response);
        }
        Ok(replies)
    }

    async fn get_snapshot_builder(&mut self) -> Self::SnapshotBuilder {
        self.snapshot_idx += 1;
        self.clone()
    }

    async fn begin_receiving_snapshot(&mut self) -> Result<Box<Cursor<Vec<u8>>>, StorageError<NodeId>> {
        Ok(Box::new(Cursor::new(Vec::new())))
    }

    async fn install_snapshot(
        &mut self,
        meta: &SnapshotMeta<NodeId, Node>,
        snapshot: Box<Cursor<Vec<u8>>>,
    ) -> Result<(), StorageError<NodeId>> {
        let bytes = snapshot.into_inner();
        let kvs: Vec<(Vec<u8>, Vec<u8>)> = serde_json::from_slice(&bytes)
            .map_err(|e| StorageIOError::read_snapshot(Some(meta.signature()), &e))?;

        self.data.last_applied_log_id = meta.last_log_id;
        self.data.last_membership = meta.last_membership.clone();

        // Atomically swap metastore default CF to the snapshot contents:
        // collect existing keys, then ONE WriteBatch: delete all old + put all new.
        let mut batch = rocksdb::WriteBatch::default();
        let iter = self.db.iterator(rocksdb::IteratorMode::Start);
        for item in iter {
            let (k, _) = item.map_err(|e| StorageError::IO {
                source: StorageIOError::read_state_machine(&e),
            })?;
            batch.delete(&k);
        }
        for (k, v) in kvs.iter() {
            batch.put(k, v);
        }
        self.db.write(batch).map_err(|e| StorageError::IO {
            source: StorageIOError::write_state_machine(&e),
        })?;
        Ok(())
    }

    async fn get_current_snapshot(&mut self) -> Result<Option<Snapshot<CubeStoreRaftTypeConfig>>, StorageError<NodeId>> {
        // PoC: build on demand; we do not yet persist snapshot meta in the DB.
        Ok(None)
    }
}
