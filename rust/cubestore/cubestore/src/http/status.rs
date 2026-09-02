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
            .and(warp::body::bytes())
            .and_then(
                move |method: warp::http::Method,
                      body: warp::hyper::body::Bytes| {
                    let p = p.clone();
                    async move {
                        let req: Option<serde_json::Value> = if body.is_empty() {
                            None
                        } else {
                            serde_json::from_slice(&body).ok()
                        };
                        let result: Result<warp::reply::Response, Infallible> = match method.as_str() {
                            "GET" => Ok(p.raft_status_reply().await),
                            "POST" => match req {
                                None => Ok(p.raft_trigger_snapshot().await),
                                Some(req) => Ok(p.raft_membership_action(req).await),
                            },
                            _ => Ok(warp::reply::with_status(
                                "method not allowed".to_string(),
                                warp::http::StatusCode::METHOD_NOT_ALLOWED,
                            )
                            .into_response()),
                        };
                        result
                    }
                },
            )
    };
    let metrics = {
        let p = p.clone();
        warp::path!("metrics").and_then(move || {
            let p = p.clone();
            async move { Ok::<_, Infallible>(p.raft_metrics_reply().await) }
        })
    };

    let addr: SocketAddr = addr.parse().expect("cannot parse status probe address");
    match warp::serve(l.or(r).or(rf).or(metrics)).try_bind_ephemeral(addr) {
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

/// Membership action execution for POST /raftz (see RouterProbes::raft_membership_action).
async fn raft_membership_action_impl(
    app: &std::sync::Arc<crate::metastore::raft::App>,
    req: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let action = req.get("action").and_then(|a| a.as_str()).unwrap_or("");
    match action {
        "add_learner" => {
            let id = req.get("id").and_then(|v| v.as_u64()).ok_or("missing 'id'")?;
            let rpc_addr = req
                .get("rpc_addr")
                .and_then(|v| v.as_str())
                .ok_or("missing 'rpc_addr'")?
                .to_string();
            app.raft
                .add_learner(
                    id,
                    crate::metastore::raft::Node { rpc_addr: rpc_addr.clone(), api_addr: rpc_addr },
                    true,
                )
                .await
                .map(|_| serde_json::json!({"added_learner": id}))
                .map_err(|e| format!("{:?}", e))
        }
        "change_membership" => {
            let members: Vec<u64> = req
                .get("members")
                .and_then(|v| v.as_array())
                .ok_or("missing 'members' array")?
                .iter()
                .filter_map(|v| v.as_u64())
                .collect();
            app.raft
                .change_membership(members.clone(), true)
                .await
                .map(|_| serde_json::json!({"membership": members}))
                .map_err(|e| format!("{:?}", e))
        }
        "remove_member" => {
            let id = req.get("id").and_then(|v| v.as_u64()).ok_or("missing 'id'")?;
            let current: Vec<u64> = app
                .raft
                .metrics()
                .borrow()
                .membership_config
                .membership()
                .nodes()
                .map(|(k, _)| *k)
                .collect();
            let remaining: Vec<u64> = current.iter().copied().filter(|x| *x != id).collect();
            if remaining.len() == current.len() {
                Err(format!("node {id} is not a member"))
            } else if remaining.is_empty() {
                Err("cannot remove the last member".to_string())
            } else {
                app.raft
                    .change_membership(remaining.clone(), true)
                    .await
                    .map(|_| serde_json::json!({"removed": id, "membership": remaining}))
                    .map_err(|e| format!("{:?}", e))
            }
        }
        other => Err(format!("unknown action '{other}'")),
    }
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

    /// POST /raftz with a JSON body — dynamic membership management
    /// (v4 runbooks RB-1 add node / RB-2 remove node):
    ///   {"action":"add_learner","id":4,"rpc_addr":"10.0.0.4:22001"}
    ///   {"action":"change_membership","members":[1,2,3,4]}
    ///   {"action":"remove_member","id":2}
    /// All operations must be issued to the leader.
    pub async fn raft_membership_action(&self, req: serde_json::Value) -> warp::reply::Response {
        let m = self.services.try_get_service_typed::<RocksMetaStore>().await;
        let app = m.as_ref().and_then(|m| m.store().raft_app_snapshot());
        let (code, body) = match app {
            None => (
                warp::http::StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({"enabled": false}).to_string(),
            ),
            Some(app) => match raft_membership_action_impl(&app, &req).await {
                Ok(v) => (warp::http::StatusCode::OK, v.to_string()),
                Err(e) => (
                    warp::http::StatusCode::INTERNAL_SERVER_ERROR,
                    serde_json::json!({"error": e}).to_string(),
                ),
            },
        };
        warp::reply::with_status(body, code).into_response()
    }

    /// Prometheus text-format exposition of Raft metrics (v4 §8): node state,
    /// leadership, term, log/apply positions and local apply lag.
    pub async fn raft_metrics_reply(&self) -> warp::reply::Response {
        let m = self
            .services
            .try_get_service_typed::<RocksMetaStore>()
            .await
            .and_then(|m| m.store().raft_metrics_snapshot());
        let body = match m {
            None => "# cubestore_raft_enabled 0\n".to_string(),
            Some(m) => {
                let is_leader = usize::from(m.current_leader == Some(m.id));
                let state = format!("{:?}", m.state);
                let last_log = m.last_log_index.unwrap_or(0);
                let last_applied = m.last_applied.map(|l| l.index).unwrap_or(0);
                format!(
                    "# TYPE cubestore_raft_enabled gauge\ncubestore_raft_enabled 1\n\
                     # TYPE cubestore_raft_is_leader gauge\ncubestore_raft_is_leader {is_leader}\n\
                     # TYPE cubestore_raft_state gauge\ncubestore_raft_state{{state=\"{state}\"}} 1\n\
                     # TYPE cubestore_raft_node gauge\ncubestore_raft_node {}\n\
                     # TYPE cubestore_raft_leader gauge\ncubestore_raft_leader {}\n\
                     # TYPE cubestore_raft_term gauge\ncubestore_raft_term {}\n\
                     # TYPE cubestore_raft_last_log_index gauge\ncubestore_raft_last_log_index {last_log}\n\
                     # TYPE cubestore_raft_last_applied gauge\ncubestore_raft_last_applied {last_applied}\n\
                     # TYPE cubestore_raft_apply_lag gauge\ncubestore_raft_apply_lag {}\n\
                     # TYPE cubestore_raft_running_state_ok gauge\ncubestore_raft_running_state_ok {}\n",
                    m.id,
                    m.current_leader.unwrap_or(0),
                    m.current_term,
                    last_log.saturating_sub(last_applied),
                    usize::from(m.running_state.is_ok()),
                )
            }
        };
        warp::reply::with_status(body, warp::http::StatusCode::OK)
            .into_response()
    }
}
