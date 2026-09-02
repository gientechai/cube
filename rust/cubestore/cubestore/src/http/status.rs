use crate::config::injection::Injector;
use crate::config::{is_router, uses_remote_metastore, Config};
use crate::metastore::{MetaStore, RocksMetaStore};
use crate::sql::SqlService;
use crate::CubeError;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use warp::http::StatusCode;
use warp::reply::Reply;
use warp::Filter;

pub fn serve_status_probes(c: &Config) {
    let addr = match c.config_obj().status_bind_address() {
        Some(a) => a.clone(),
        None => return,
    };

    let p = match RouterProbes::try_new(c) {
        Some(p) => p,
        None => return,
    };

    let pc = p.clone();
    let l = warp::path!("livez").and_then(move || {
        let pc = pc.clone();
        async move { status_probe_reply("liveness", pc.is_live().await) }
    });
    let p_ready = p.clone();
    let r = warp::path!("readyz").and_then(move || {
        let p = p_ready.clone();
        async move { status_probe_reply("readiness", p.is_ready().await) }
    });
    let rf = {
        let p = p.clone();
        warp::path!("raftz")
            .and(warp::method())
            .and_then(move |method: warp::http::Method| {
                let p = p.clone();
                async move {
                    let result: Result<warp::reply::Response, Infallible> = match method.as_str() {
                        "GET" => Ok(p.raft_status_reply().await),
                        "POST" => Ok(p.raft_trigger_snapshot().await),
                        _ => Ok(warp::reply::with_status(
                            "method not allowed".to_string(),
                            warp::http::StatusCode::METHOD_NOT_ALLOWED,
                        )
                        .into_response()),
                    };
                    result
                }
            })
    };

    let addr: SocketAddr = addr.parse().expect("cannot parse status probe address");
    match warp::serve(l.or(r).or(rf)).try_bind_ephemeral(addr) {
        Ok((addr, f)) => {
            log::info!("Serving status probes at {}", addr);
            tokio::spawn(f);
        }
        Err(e) => {
            log::error!("Failed to serve status probes at {}: {}", addr, e);
        }
    }
}

pub fn status_probe_reply(probe: &str, r: Result<(), CubeError>) -> Result<StatusCode, Infallible> {
    match r {
        Ok(()) => Ok(StatusCode::OK),
        Err(e) => {
            log::warn!("{} probe failed: {}", probe, e.display_with_backtrace());
            Ok(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

#[derive(Clone)]
struct RouterProbes {
    services: Arc<Injector>,
}

impl RouterProbes {
    pub fn try_new(config: &Config) -> Option<RouterProbes> {
        if !is_router(config.config_obj().as_ref()) {
            return None;
        }
        Some(RouterProbes {
            services: config.injector(),
        })
    }

    pub async fn is_live(&self) -> Result<(), CubeError> {
        if let Some(s) = self
            .services
            .try_get_service_typed::<dyn SqlService>()
            .await
        {
            s.exec_query("SELECT 1").await?;
        }
        Ok(())
    }

    pub async fn is_ready(&self) -> Result<(), CubeError> {
        if uses_remote_metastore(&self.services).await {
            return Ok(());
        }
        let m = match self.services.try_get_service_typed::<dyn MetaStore>().await {
            None => return Err(CubeError::internal("metastore is not ready".to_string())),
            Some(m) => m,
        };
        // Check metastore is not stalled.
        m.get_schemas().await?;
        // It is tempting to check worker connectivity on the router, but we cannot do this now.
        // Workers connect to the router for warmup, so router must be ready before workers are up.
        // TODO: warmup explicitly with router request instead?
        Ok(())
    }

    /// Raft observability endpoint (v4 §8): current node/leader/term/apply
    /// position as JSON. 503 + {"enabled": false} when this node does not run
    /// the rocksdb-raft metastore backend. Intentionally does NOT gate
    /// readiness: a temporary leaderless window (election in progress) must not
    /// pull every router out of the LB.
    pub async fn raft_status_reply(&self) -> warp::reply::Response {
        let m = self.services.try_get_service_typed::<RocksMetaStore>().await;
        let metrics = m.as_ref().and_then(|m| m.store().raft_metrics_snapshot());
        let (code, body) = match metrics {
            None => (
                warp::http::StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({"enabled": false}).to_string(),
            ),
            Some(m) => (
                warp::http::StatusCode::OK,
                serde_json::json!({
                    "enabled": true,
                    "node": m.id,
                    "state": format!("{:?}", m.state),
                    "leader": m.current_leader,
                    "term": m.current_term,
                    "last_log_index": m.last_log_index,
                    "last_applied": m.last_applied.map(|l| l.index),
                    "running_state_ok": m.running_state.is_ok(),
                })
                .to_string(),
            ),
        };
        warp::reply::with_status(body, code).into_response()
    }

    /// POST /raftz — manually trigger a Raft snapshot build on this node
    /// (v4 runbook RB-4). Snapshots normally build automatically every
    /// LogsSinceLast(1000) applied entries; the endpoint covers "snapshot
    /// now" before maintenance or node replacement.
    pub async fn raft_trigger_snapshot(&self) -> warp::reply::Response {
        let m = self.services.try_get_service_typed::<RocksMetaStore>().await;
        let app = m.as_ref().and_then(|m| m.store().raft_app_snapshot());
        let (code, body) = match app {
            None => (
                warp::http::StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({"enabled": false}).to_string(),
            ),
            Some(app) => {
                // trigger_snapshot only builds on the leader; on followers it
                // just updates the internal snapshot state — report which.
                match app.raft.trigger().snapshot().await {
                    Ok(()) => {
                        let m = m.unwrap().store().raft_metrics_snapshot();
                        (
                            warp::http::StatusCode::OK,
                            serde_json::json!({
                                "triggered": true,
                                "node": m.as_ref().map(|x| x.id),
                                "is_leader": m.as_ref().map(|x| x.current_leader == Some(x.id)),
                            })
                            .to_string(),
                        )
                    }
                    Err(e) => (
                        warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                        serde_json::json!({"triggered": false, "error": format!("{:?}", e)})
                            .to_string(),
                    ),
                }
            }
        };
        warp::reply::with_status(body, code).into_response()
    }
}
