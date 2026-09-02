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
    /// Local MetaStoreEvent listeners (RocksStore.listeners). apply() fires the
    /// batch's events here so EVERY replica notifies its local cluster
    /// components — follower event fan-out. Shared via Arc, so listeners added
    /// to the RocksStore after Raft startup are still seen by this clone.
    listeners: Listeners,
}

/// Same type as RocksStore.listeners.
pub type Listeners = std::sync::Arc<
    tokio::sync::RwLock<Vec<tokio::sync::broadcast::Sender<crate::metastore::MetaStoreEvent>>>,
>;

/// Reserved key holding the persisted `StoredSnapshot` in the metastore
/// default CF. Business keys are prefixed with a `TableId` (0x0100..0x1000),
/// so a leading-`_` ASCII key never collides. Iterators that dump the CF for
/// snapshotting must skip this key to avoid nesting snapshots.
const SNAPSHOT_KEY: &[u8] = b"__raft_sm_snapshot__";

/// On-disk snapshot representation, persisted under `SNAPSHOT_KEY`.
/// The data blob is a serialized `Vec<(key, value)>` dump of the metastore default CF.
#[derive(Serialize, Deserialize, Debug, Clone)]
struct StoredSnapshot {
    meta: SnapshotMeta<NodeId, Node>,
    data: Vec<u8>,
}

impl StateMachineStore {
    /// Construct with the metastore RocksDB handle and the RocksStore's event
    /// listeners. Restores `last_applied`/`last_membership` from the persisted
    /// snapshot meta when present, so a restarted node does not force Raft to
    /// replay the entire log from index 0. The business data itself is already
    /// in the DB — only the Raft positions are restored.
    pub async fn new(db: Arc<DB>, listeners: Listeners) -> Self {
        let mut sm = Self {
            data: StateMachineData {
                last_applied_log_id: None,
                last_membership: Default::default(),
            },
            snapshot_idx: 0,
            db,
            listeners,
        };
        match sm.read_stored_snapshot() {
            Ok(Some(stored)) => {
                log::info!(
                    "Raft state machine restored from persisted snapshot: last_applied={:?}",
                    stored.meta.last_log_id
                );
                sm.data.last_applied_log_id = stored.meta.last_log_id;
                sm.data.last_membership = stored.meta.last_membership.clone();
            }
            Ok(None) => {}
            Err(e) => {
                // A corrupt snapshot must not brick the node: fall back to full
                // log replay, which rebuilds identical state.
                log::warn!("Raft persisted snapshot unreadable, will replay log: {}", e);
            }
        }
        sm
    }

    fn read_stored_snapshot(&self) -> Result<Option<StoredSnapshot>, String> {
        let bytes = self
            .db
            .get(SNAPSHOT_KEY)
            .map_err(|e| format!("read {}: {e:?}", String::from_utf8_lossy(SNAPSHOT_KEY)))?;
        match bytes {
            None => Ok(None),
            Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        }
    }

    fn write_stored_snapshot(&self, stored: &StoredSnapshot) -> Result<(), StorageError<NodeId>> {
        // JSON, not flexbuffers: SnapshotMeta carries StoredMembership with a
        // BTreeMap<NodeId, Node>, and flexbuffers map keys must be strings
        // (e2e-verified KeyMustBeString, which fatally shuts down RaftCore).
        let bytes = serde_json::to_vec(stored).map_err(|e| StorageError::IO {
            source: StorageIOError::write_state_machine(&e),
        })?;
        self.db.put(SNAPSHOT_KEY, bytes).map_err(|e| StorageError::IO {
            source: StorageIOError::write_state_machine(&e),
        })
    }

    fn snapshot_from_stored(stored: StoredSnapshot) -> Snapshot<CubeStoreRaftTypeConfig> {
        let SnapshotMeta { last_log_id, last_membership, snapshot_id } = stored.meta.clone();
        Snapshot {
            meta: SnapshotMeta { last_log_id, last_membership, snapshot_id },
            snapshot: Box::new(Cursor::new(stored.data)),
        }
    }
}

impl RaftSnapshotBuilder<CubeStoreRaftTypeConfig> for StateMachineStore {
    async fn build_snapshot(&mut self) -> Result<Snapshot<CubeStoreRaftTypeConfig>, StorageError<NodeId>> {
        let last_applied_log = self.data.last_applied_log_id;
        let last_membership = self.data.last_membership.clone();

        // Dump the entire metastore default CF as (key, value) pairs, skipping
        // the reserved snapshot key so snapshots do not nest.
        // PoC: acceptable for small metastore; production should use RocksDB
        // Checkpoint (cube already has upload_check_point machinery).
        let mut kvs: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        let iter = self.db.iterator(rocksdb::IteratorMode::Start);
        for item in iter {
            let (k, v) = item.map_err(|e| StorageError::IO {
                source: StorageIOError::read_state_machine(&e),
            })?;
            if k.as_ref() == SNAPSHOT_KEY {
                continue;
            }
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
        let stored = StoredSnapshot { meta: meta.clone(), data: data_bytes };
        // Persist BEFORE handing the snapshot to Raft: if we crash after Raft
        // records the snapshot log position, the on-disk copy must already
        // exist for restart recovery.
        self.write_stored_snapshot(&stored)?;
        log::info!(
            "Raft snapshot built and persisted: id={}, {} kv pairs",
            meta.snapshot_id,
            kvs.len()
        );

        Ok(Self::snapshot_from_stored(stored))
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

                    // Follower event fan-out (v4): fire the originating write's
                    // MetaStoreEvents (JSON-encoded in the batch) on THIS node
                    // so local cluster components (job runner, partition
                    // scheduling, schema invalidation) observe replicated
                    // changes. Notification failures (e.g. a listener with no
                    // receivers) must not fail the apply.
                    let events = wb.decode_events();
                    if !events.is_empty() {
                        let count = events.len();
                        let listeners = self.listeners.read().await;
                        for listener in listeners.iter() {
                            for event in events.iter() {
                                let _ = listener.send(event.clone());
                            }
                        }
                        log::info!("Raft apply: fired {} MetaStoreEvents on this node", count);
                    }
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
        // The delete pass also clears SNAPSHOT_KEY, which is rewritten below.
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

        // Persist the installed snapshot so a subsequent restart restores from
        // the installed position instead of replaying the log.
        self.write_stored_snapshot(&StoredSnapshot { meta: meta.clone(), data: bytes })?;
        Ok(())
    }

    async fn get_current_snapshot(&mut self) -> Result<Option<Snapshot<CubeStoreRaftTypeConfig>>, StorageError<NodeId>> {
        match self.read_stored_snapshot() {
            Ok(Some(stored)) => Ok(Some(Self::snapshot_from_stored(stored))),
            Ok(None) => Ok(None),
            // Unreadable persisted snapshot: report none; Raft falls back to
            // log replication for lagging nodes.
            Err(_) => Ok(None),
        }
    }
}
