//! Metastore write/read benchmark: plain RocksDB vs rocksdb-raft (1 or 3
//! members), quantifying the Raft overhead added by the HA PoC — the Raft
//! framework, quorum replication (real toy_rpc WebSockets between in-process
//! members) and write_via_raft's wait_local_applied.
//!
//! Usage:
//!   BENCH_MODE=plain|raft1|raft3 [BENCH_N=1000] [BENCH_READ_N=1000] \
//!     cargo run --release --bin raft-bench
//!
//! Results on this PoC branch (M1, debug build): see docs/superpowers/specs/
//! 2026-07-08-cubestore-ha-gap-analysis.md — v4 §13 claims single-leader Raft
//! is nowhere near a bottleneck at metastore write rates (~15/s peak); this
//! benchmark turns that claim into measured numbers.

use std::sync::Arc;
use std::time::Instant;

use cubestore::config::Config;
use cubestore::metastore::raft::{self, App};
use cubestore::metastore::{BaseRocksStoreFs, MetaStore, RocksMetaStore};
use cubestore::remotefs::LocalDirRemoteFs;
use cubestore::CubeError;

fn percentiles(mut latencies_us: Vec<u128>) -> (u128, u128, u128) {
    latencies_us.sort();
    let at = |q: f64| -> u128 {
        let idx = ((latencies_us.len() as f64 - 1.0) * q).round() as usize;
        latencies_us[idx.min(latencies_us.len() - 1)]
    };
    (at(0.50), at(0.95), at(0.99))
}

fn tail_stats(latencies_us: &[u128]) -> (u128, u128) {
    let mut v = latencies_us.to_vec();
    v.sort();
    let at = |q: f64| -> u128 {
        let idx = ((v.len() as f64 - 1.0) * q).round() as usize;
        v[idx.min(v.len() - 1)]
    };
    (at(0.999), *v.last().unwrap_or(&0))
}

async fn build_metastore(dir: &std::path::Path) -> Result<Arc<RocksMetaStore>, CubeError> {
    let config = Config::test("raft_bench");
    let remote_fs = LocalDirRemoteFs::new(Some(dir.join("remote")), dir.join("local"));
    let metastore_fs = BaseRocksStoreFs::new_for_metastore(remote_fs, config.config_obj());
    let path = dir.join("metastore");
    let path = path.to_str().unwrap().to_string();
    let meta_store = RocksMetaStore::load_from_remote(&path, metastore_fs, config.config_obj())
        .await
        .unwrap();
    Ok(meta_store)
}

#[tokio::main]
async fn main() {
    let mode = std::env::var("BENCH_MODE").unwrap_or_else(|_| "plain".to_string());
    let n: usize = std::env::var("BENCH_N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);
    let read_n: usize = std::env::var("BENCH_READ_N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);

    let base = std::env::temp_dir().join(format!("cs-raft-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();

    println!("mode={} writes={} reads={}", mode, n, read_n);

    let m1 = build_metastore(&base.join("n1")).await.expect("metastore n1");

    match mode.as_str() {
        "plain" => {}
        "raft1" => {
            let app = wire_raft_full(&m1, &base.join("n1"), 1, "127.0.0.1:25001", "1@127.0.0.1:25001")
                .await
                .expect("raft1 wiring");
            // election takes a moment on a single voter
            for _ in 0..50 {
                if app.raft.metrics().borrow().current_leader.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
        "raft3" => {
            let m2 = build_metastore(&base.join("n2")).await.expect("metastore n2");
            let m3 = build_metastore(&base.join("n3")).await.expect("metastore n3");
            let members = "1@127.0.0.1:25001,2@127.0.0.1:25002,3@127.0.0.1:25003";
            let apps = vec![
                wire_raft_full(&m1, &base.join("n1"), 1, "127.0.0.1:25001", members)
                    .await
                    .expect("raft3 n1"),
                wire_raft_full(&m2, &base.join("n2"), 2, "127.0.0.1:25002", members)
                    .await
                    .expect("raft3 n2"),
                wire_raft_full(&m3, &base.join("n3"), 3, "127.0.0.1:25003", members)
                    .await
                    .expect("raft3 n3"),
            ];
            // wait for a leader
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            'outer: while std::time::Instant::now() < deadline {
                for app in &apps {
                    if app.raft.metrics().borrow().current_leader.is_some() {
                        break 'outer;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
        other => panic!("unknown BENCH_MODE '{other}' (plain|raft1|raft3)"),
    }

    // Warm-up: the very first write after a fresh election can hit the
    // ForwardToLeader window (leader not yet committed) and takes seconds —
    // excluded from the steady-state measurement.
    for i in 0..3 {
        let _ = m1.create_schema(format!("bench_warmup_{i}"), true).await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // ---- write benchmark: create_schema ----
    let mut lat = Vec::with_capacity(n);
    let start = Instant::now();
    let mut ok = 0usize;
    for i in 0..n {
        let t = Instant::now();
        match m1.create_schema(format!("bench_{i}"), true).await {
            Ok(_) => {
                ok += 1;
                lat.push(t.elapsed().as_micros());
            }
            Err(e) => {
                eprintln!("write failed at {i}: {}", e.message);
            }
        }
    }
    let write_elapsed = start.elapsed();
    let (p50, p95, p99) = percentiles(lat.clone());
    let (p999, mx) = tail_stats(&lat);
    println!(
        "WRITE  ok={}/{} qps={:.0} p50={}µs p95={}µs p99={}µs p999={}µs max={}µs total={:?}",
        ok,
        n,
        ok as f64 / write_elapsed.as_secs_f64(),
        p50,
        p95,
        p99,
        p999,
        mx,
        write_elapsed
    );

    // ---- read benchmark: get_schemas ----
    let mut lat = Vec::with_capacity(read_n);
    let start = Instant::now();
    let mut ok = 0usize;
    for _ in 0..read_n {
        let t = Instant::now();
        if m1.get_schemas().await.is_ok() {
            ok += 1;
            lat.push(t.elapsed().as_micros());
        }
    }
    let read_elapsed = start.elapsed();
    let (p50, p95, p99) = percentiles(lat);
    println!(
        "READ   ok={}/{} qps={:.0} p50={}µs p95={}µs p99={}µs total={:?}",
        ok,
        read_n,
        ok as f64 / read_elapsed.as_secs_f64(),
        p50,
        p95,
        p99,
        read_elapsed
    );

    let _ = std::fs::remove_dir_all(&base);
}

/// Full wiring with an explicit directory (the metastore path lives outside
/// RocksStore's public API).
async fn wire_raft_full(
    meta_store: &Arc<RocksMetaStore>,
    dir: &std::path::Path,
    node_id: raft::NodeId,
    rpc_addr: &str,
    members: &str,
) -> Result<Arc<App>, CubeError> {
    let rocks_store = meta_store.store();
    let db = rocks_store.db.clone();

    let log_store = raft::LogStore::open(&format!("{}/metastore.raft_log", dir.display()));
    let sm_store = raft::StateMachineStore::new(db, rocks_store.listeners.clone()).await;
    let raft_config = Arc::new(
        openraft::Config {
            heartbeat_interval: 250,
            election_timeout_min: 299,
            snapshot_policy: openraft::SnapshotPolicy::LogsSinceLast(1000),
            ..Default::default()
        }
        .validate()
        .unwrap(),
    );
    let raft = openraft::Raft::new(node_id, raft_config.clone(), raft::Network, log_store, sm_store)
        .await
        .unwrap();
    let app = Arc::new(App {
        id: node_id,
        rpc_addr: rpc_addr.to_string(),
        api_addr: rpc_addr.to_string(),
        tokio_handle: tokio::runtime::Handle::current(),
        raft,
        config: raft_config,
    });
    rocks_store.set_raft_app(app.clone());
    app.serve_raft_rpc()
        .await
        .expect("bench: Raft RPC serve failed");
    std::env::set_var("CUBESTORE_RAFT_NODES", members);
    raft::bootstrap_cluster(&app).await.expect("bench: bootstrap failed");
    Ok(app)
}
