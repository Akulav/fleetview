//! Discovery + TLS control channel to the master.

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::mpsc;
use tokio_rustls::TlsConnector;
use tokio_util::codec::{Framed, LengthDelimitedCodec};
use tokio_util::sync::CancellationToken;

use fleetview_shared::discovery::{DiscoveryBeacon, DiscoveryQuery};
use fleetview_shared::protocol::{AgentMsg, Hello, MasterMsg};
use fleetview_shared::{crypto, DISCOVERY_MAGIC, DISCOVERY_PORT, PROTOCOL_VERSION};

use crate::config::AgentConfig;
use crate::ipc::{HelperCommand, HelperEvent, Hub};

/// Reconnect forever until shutdown.
pub async fn connection_loop(cfg: AgentConfig, hub: Hub, shutdown: CancellationToken) {
    let mut backoff = 2u64;
    // Consecutive failed attempts. With a fixed `master_address` that has
    // stopped working (master moved, or a remote config typo), alternate with
    // UDP discovery after a few failures instead of being cut off for good.
    let mut failures = 0u32;
    let has_fixed = cfg
        .master_address
        .as_deref()
        .is_some_and(|a| !a.trim().is_empty());
    loop {
        if shutdown.is_cancelled() {
            break;
        }
        let broadcast = has_fixed && failures >= 3 && failures % 2 == 1;
        if broadcast {
            tracing::info!("fixed master address keeps failing; trying discovery");
        }
        match discover_master(&cfg, &shutdown, broadcast).await {
            Ok(found) => {
                tracing::info!("master at {}", found.addr);
                let started = std::time::Instant::now();
                match run_session(&cfg, &found, &hub, &shutdown).await {
                    Ok(()) => {
                        backoff = 2;
                        failures = 0;
                    }
                    Err(e) => {
                        tracing::warn!("session ended: {e:#}");
                        // A long, working session that later dropped is not a
                        // sign of a bad address.
                        if started.elapsed() > Duration::from_secs(60) {
                            failures = 0;
                        } else {
                            failures += 1;
                        }
                    }
                }
                // Never keep capturing the user's screen once the master that
                // asked for it is gone.
                hub.send_to_helper(HelperCommand::StopStream);
            }
            Err(e) => {
                tracing::info!("master not found yet: {e:#}");
                failures += 1;
            }
        }
        hub.set_connected(false, "").await;
        // Wait before retrying, capped.
        tokio::select! {
            _ = shutdown.cancelled() => break,
            _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
        }
        backoff = (backoff * 2).min(30);
    }
}

/// Where the master is and what it calls itself.
struct FoundMaster {
    addr: SocketAddr,
    name: String,
}

/// Find the master either via the configured fixed address or UDP discovery
/// (`force_broadcast` skips the fixed address for this attempt). Either way the
/// TLS session that follows pins the master's certificate, so a wrong address
/// can only fail, never connect us to an impostor.
async fn discover_master(
    cfg: &AgentConfig,
    shutdown: &CancellationToken,
    force_broadcast: bool,
) -> Result<FoundMaster> {
    if let Some(addr) = cfg
        .master_address
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty() && !force_broadcast)
    {
        // Accept a bare host/IP too and default to the standard port.
        let target = if addr.contains(':') {
            addr.to_string()
        } else {
            format!("{addr}:{}", fleetview_shared::DEFAULT_CONTROL_PORT)
        };
        let sa = tokio::net::lookup_host(&target)
            .await
            .with_context(|| format!("resolve {target}"))?
            .next()
            .with_context(|| format!("no address for {target}"))?;
        return Ok(FoundMaster {
            addr: sa,
            name: target,
        });
    }

    let sock = UdpSocket::bind(("0.0.0.0", 0)).await?;
    sock.set_broadcast(true)?;

    let query = DiscoveryQuery {
        protocol: PROTOCOL_VERSION,
        hostname: hostname(),
    };
    let mut datagram = DISCOVERY_MAGIC.to_vec();
    datagram.push(0);
    datagram.extend_from_slice(&rmp_serde::to_vec_named(&query)?);

    // Broadcast to the global broadcast address plus any configured targets.
    let mut targets: Vec<String> = vec![format!("255.255.255.255:{DISCOVERY_PORT}")];
    targets.extend(cfg.discovery_targets.iter().cloned());
    for t in &targets {
        if let Ok(mut addrs) = tokio::net::lookup_host(t).await {
            if let Some(a) = addrs.next() {
                let _ = sock.send_to(&datagram, a).await;
            }
        }
    }

    // Await a valid, signed beacon for a few seconds.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    let mut buf = vec![0u8; 8192];
    loop {
        let timeout = deadline.saturating_duration_since(tokio::time::Instant::now());
        if timeout.is_zero() {
            anyhow::bail!("no beacon within timeout");
        }
        tokio::select! {
            _ = shutdown.cancelled() => anyhow::bail!("shutting down"),
            _ = tokio::time::sleep(timeout) => anyhow::bail!("no beacon within timeout"),
            res = sock.recv_from(&mut buf) => {
                let (n, src) = res?;
                if let Some(found) = parse_beacon(cfg, &buf[..n], src) {
                    return Ok(found);
                }
            }
        }
    }
}

fn parse_beacon(cfg: &AgentConfig, data: &[u8], src: SocketAddr) -> Option<FoundMaster> {
    let prefix_len = DISCOVERY_MAGIC.len() + 1;
    if data.len() <= prefix_len || &data[..DISCOVERY_MAGIC.len()] != DISCOVERY_MAGIC {
        return None;
    }
    let beacon: DiscoveryBeacon = rmp_serde::from_slice(&data[prefix_len..]).ok()?;
    if beacon.protocol != PROTOCOL_VERSION {
        return None;
    }
    // Verify the master's signature over the beacon.
    if !crypto::verify_signature(
        &cfg.master_public_key,
        &beacon.canonical_bytes(),
        &beacon.signature,
    ) {
        tracing::warn!("ignoring beacon from {src}: bad signature");
        return None;
    }
    // Pinned cert fingerprint must match what we expect.
    if !crypto::secrets_match(
        &beacon.cert_fingerprint.to_lowercase(),
        &cfg.master_cert_fingerprint.to_lowercase(),
    ) {
        tracing::warn!("ignoring beacon from {src}: cert fingerprint mismatch");
        return None;
    }
    // NOTE: a valid beacon can be replayed from another IP (it is not bound to
    // the sender's address). That only misdirects us: the TLS handshake below
    // proves possession of the master's private key, so a replaying host can't
    // complete it and we simply retry discovery.
    Some(FoundMaster {
        addr: SocketAddr::new(src.ip(), beacon.control_port),
        name: beacon.master_name,
    })
}

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);

async fn run_session(
    cfg: &AgentConfig,
    found: &FoundMaster,
    hub: &Hub,
    shutdown: &CancellationToken,
) -> Result<()> {
    let tcp = tokio::time::timeout(HANDSHAKE_TIMEOUT, TcpStream::connect(found.addr))
        .await
        .context("tcp connect timed out")?
        .context("tcp connect")?;
    tcp.set_nodelay(true).ok();
    // Always pin the fingerprint from our own config, never one taken from the network.
    let connector = TlsConnector::from(crate::tls::client_config(&cfg.master_cert_fingerprint));
    let server_name =
        rustls::pki_types::ServerName::try_from("fleetview-master").context("server name")?;
    let tls = tokio::time::timeout(HANDSHAKE_TIMEOUT, connector.connect(server_name, tcp))
        .await
        .context("tls handshake timed out")?
        .context("tls handshake")?;

    let mut framed = Framed::new(
        tls,
        LengthDelimitedCodec::builder()
            .max_frame_length(fleetview_shared::MAX_FRAME_BYTES)
            .new_codec(),
    );

    // Say hello and provide the enrollment secret.
    let hello = AgentMsg::Hello(Hello {
        protocol: PROTOCOL_VERSION,
        agent_id: cfg.agent_id.clone(),
        hostname: hostname(),
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        enrollment_secret: cfg.enrollment_secret.clone(),
        agent_key: cfg.agent_key.clone(),
    });
    framed.send(encode(&hello)?).await?;

    // Expect an ack.
    let ack = tokio::time::timeout(HANDSHAKE_TIMEOUT, framed.next())
        .await
        .context("hello ack timed out")?
        .context("no hello ack")??;
    match rmp_serde::from_slice::<MasterMsg>(&ack)? {
        MasterMsg::HelloAck { accepted: true, .. } => {}
        MasterMsg::HelloAck {
            accepted: false,
            reason,
        } => {
            anyhow::bail!("master rejected enrollment: {reason}");
        }
        other => anyhow::bail!("unexpected first message: {other:?}"),
    }

    let master_name = if found.name.is_empty() {
        "master"
    } else {
        found.name.as_str()
    };
    hub.set_connected(true, master_name).await;
    tracing::info!("connected and enrolled with master");

    // Outbound queue so background tasks (command results, telemetry) don't block
    // the read side.
    let (tx_out, mut rx_out) = mpsc::channel::<AgentMsg>(256);

    // Helper events (screen frames / logs) → master.
    let mut helper_rx = hub.subscribe_events();

    let mut telemetry_tick =
        tokio::time::interval(Duration::from_secs(cfg.telemetry_interval_secs.max(5)));
    let mut heartbeat_tick = tokio::time::interval(Duration::from_secs(20));
    // Mirror "an installer is running" to the tray icon.
    let mut busy_tick = tokio::time::interval(Duration::from_secs(1));
    let mut busy_shown = false;

    // Send an immediate telemetry snapshot.
    spawn_telemetry(hub.clone(), tx_out.clone());

    // In-flight file transfers.
    let mut transfers: std::collections::HashMap<String, crate::commands::FileTransfer> =
        std::collections::HashMap::new();

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,

            Some(msg) = rx_out.recv() => {
                framed.send(encode(&msg)?).await?;
            }

            _ = telemetry_tick.tick() => {
                spawn_telemetry(hub.clone(), tx_out.clone());
            }

            _ = heartbeat_tick.tick() => {
                framed.send(encode(&AgentMsg::Heartbeat)?).await?;
            }

            _ = busy_tick.tick() => {
                let busy = crate::commands::installs_running();
                if busy != busy_shown {
                    busy_shown = busy;
                    hub.send_to_helper(HelperCommand::Busy(busy));
                }
            }

            evt = helper_rx.recv() => {
                match evt {
                    Ok(HelperEvent::ScreenFrame { command_id, width, height, jpeg }) => {
                        let msg = AgentMsg::ScreenFrame {
                            command_id, width, height, jpeg: jpeg.into_vec(),
                        };
                        framed.send(encode(&msg)?).await?;
                    }
                    Ok(HelperEvent::Log { level, message }) => {
                        framed.send(encode(&AgentMsg::Log { level, message })?).await?;
                    }
                    Ok(HelperEvent::Hello { .. }) => { /* tracked in hub */ }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => {}
                }
            }

            incoming = framed.next() => {
                let Some(frame) = incoming else { break };
                let frame = frame?;
                let msg: MasterMsg = rmp_serde::from_slice(&frame)?;
                handle_master_msg(msg, hub, &tx_out, &mut transfers).await;
            }
        }
    }

    Ok(())
}

async fn handle_master_msg(
    msg: MasterMsg,
    hub: &Hub,
    tx_out: &mpsc::Sender<AgentMsg>,
    transfers: &mut std::collections::HashMap<String, crate::commands::FileTransfer>,
) {
    match msg {
        MasterMsg::HelloAck { .. } => {}
        MasterMsg::Ping => {
            let _ = tx_out.send(AgentMsg::Heartbeat).await;
        }
        MasterMsg::RequestTelemetry => spawn_telemetry(hub.clone(), tx_out.clone()),
        MasterMsg::RequestSoftware => {
            let tx = tx_out.clone();
            tokio::task::spawn_blocking(move || {
                let list = crate::inventory::installed_software();
                let _ = tx.blocking_send(AgentMsg::Software(list));
            });
        }
        MasterMsg::RunPowerShell { command_id, script } => {
            let tx = tx_out.clone();
            tokio::spawn(async move {
                let result = crate::commands::run_powershell(command_id, script).await;
                let _ = tx.send(AgentMsg::CommandResult(result)).await;
            });
        }
        MasterMsg::FileBegin {
            transfer_id,
            file_name,
            total_len,
            run_after,
        } => {
            let command_id = run_after.as_ref().map(|r| r.command_id.clone());
            match crate::commands::FileTransfer::begin(
                &transfer_id,
                &file_name,
                total_len,
                run_after,
            ) {
                Ok(t) => {
                    transfers.insert(transfer_id, t);
                }
                Err(e) => {
                    tracing::warn!("file begin failed: {e:#}");
                    report_failure(tx_out, command_id, format!("file push failed: {e:#}")).await;
                }
            }
        }
        MasterMsg::FileChunk { transfer_id, data } => {
            if let Some(t) = transfers.get_mut(&transfer_id) {
                if let Err(e) = t.write(&data) {
                    tracing::warn!("file chunk failed: {e:#}");
                    // Drop the transfer (removes the partial file) and say so.
                    if let Some(t) = transfers.remove(&transfer_id) {
                        let command_id = t.command_id().map(str::to_string);
                        drop(t);
                        report_failure(tx_out, command_id, format!("file push failed: {e:#}"))
                            .await;
                    }
                } else {
                    let _ = tx_out
                        .send(AgentMsg::FileAck {
                            transfer_id,
                            received: t.received(),
                        })
                        .await;
                }
            }
        }
        MasterMsg::FileEnd { transfer_id } => {
            if let Some(t) = transfers.remove(&transfer_id) {
                let tx = tx_out.clone();
                tokio::spawn(async move {
                    if let Some(result) = t.finish().await {
                        let _ = tx.send(AgentMsg::CommandResult(result)).await;
                    }
                });
            }
        }
        MasterMsg::InstallFromUrl {
            command_id,
            url,
            run,
        } => {
            let tx = tx_out.clone();
            tokio::spawn(async move {
                let result = crate::commands::install_from_url(command_id, url, run).await;
                let _ = tx.send(AgentMsg::CommandResult(result)).await;
            });
        }
        MasterMsg::RequestScreenshot { command_id } => {
            hub.send_to_helper(HelperCommand::CaptureOnce { command_id });
        }
        MasterMsg::StartScreenStream {
            interval_ms,
            jpeg_quality,
        } => {
            hub.send_to_helper(HelperCommand::StartStream {
                interval_ms,
                jpeg_quality,
            });
        }
        MasterMsg::StopScreenStream => hub.send_to_helper(HelperCommand::StopStream),
        MasterMsg::NotifyUser { title, body } => {
            hub.send_to_helper(HelperCommand::Notify { title, body });
        }
        MasterMsg::SetConfig {
            command_id,
            updates,
        } => {
            let tx = tx_out.clone();
            tokio::spawn(async move {
                let result = apply_config(command_id, updates).await;
                let _ = tx.send(AgentMsg::CommandResult(result)).await;
            });
        }
    }
}

/// Apply a remote config change on a blocking thread, then schedule a service
/// restart so it takes effect. The result reaches the master before the restart
/// drops the connection; the agent reconnects a few seconds later with the new
/// settings.
async fn apply_config(
    command_id: String,
    updates: Vec<fleetview_shared::protocol::ConfigUpdate>,
) -> fleetview_shared::protocol::CommandResult {
    use fleetview_shared::protocol::CommandResult;
    let pairs: Vec<(String, Option<String>)> =
        updates.into_iter().map(|u| (u.key, u.value)).collect();
    let outcome =
        tokio::task::spawn_blocking(move || crate::config::apply_remote_config(&pairs)).await;
    match outcome {
        Ok(Ok(changed)) if changed.is_empty() => CommandResult {
            command_id,
            success: true,
            exit_code: Some(0),
            stdout: "config unchanged (values already set)".into(),
            stderr: String::new(),
        },
        Ok(Ok(changed)) => {
            crate::commands::audit(&format!("config changed remotely: {}", changed.join(", ")));
            tracing::info!(
                "config changed ({}); restarting service",
                changed.join(", ")
            );
            crate::setup::schedule_service_restart();
            CommandResult {
                command_id,
                success: true,
                exit_code: Some(0),
                stdout: format!(
                    "updated {}; the agent restarts to apply it",
                    changed.join(", ")
                ),
                stderr: String::new(),
            }
        }
        Ok(Err(e)) => CommandResult {
            command_id,
            success: false,
            exit_code: None,
            stdout: String::new(),
            stderr: format!("{e:#}"),
        },
        Err(e) => CommandResult {
            command_id,
            success: false,
            exit_code: None,
            stdout: String::new(),
            stderr: format!("apply config task failed: {e}"),
        },
    }
}

async fn report_failure(tx: &mpsc::Sender<AgentMsg>, command_id: Option<String>, msg: String) {
    let _ = tx
        .send(AgentMsg::CommandResult(
            fleetview_shared::protocol::CommandResult {
                command_id: command_id.unwrap_or_default(),
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: msg,
            },
        ))
        .await;
}

fn spawn_telemetry(hub: Hub, tx: mpsc::Sender<AgentMsg>) {
    tokio::spawn(async move {
        let user = hub.0.user.lock().await.clone();
        let t = tokio::task::spawn_blocking(move || crate::telemetry::gather(user))
            .await
            .ok();
        if let Some(t) = t {
            let _ = tx.send(AgentMsg::Telemetry(t)).await;
        }
    });
}

fn encode(msg: &AgentMsg) -> Result<bytes::Bytes> {
    Ok(rmp_serde::to_vec_named(msg)?.into())
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(sysinfo::System::host_name)
        .unwrap_or_else(|| "unknown".into())
}
