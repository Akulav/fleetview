//! Async backend: TLS control server, signed discovery responder, and the
//! per-agent connection tasks that keep [`crate::state::Shared`] up to date.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::Local;
use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

use fleetview_shared::discovery::{DiscoveryBeacon, DiscoveryQuery};
use fleetview_shared::protocol::{AgentMsg, MasterMsg};
use fleetview_shared::{DISCOVERY_MAGIC, DISCOVERY_PORT, PROTOCOL_VERSION};

use crate::settings::MasterSettings;
use crate::state::{push_bounded, save_known, AgentView, ScreenFrame, SharedState};

/// TLS handshake + Hello must complete within this.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// An enrolled agent that sends nothing (not even a heartbeat) for this long is
/// considered gone.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// Frame size limit before enrollment (a Hello is a few hundred bytes).
const PRE_AUTH_MAX_FRAME: usize = 64 * 1024;
/// Per-agent console buffer cap.
const CONSOLE_MAX_BYTES: usize = 200_000;

pub fn spawn_backend(settings: MasterSettings, state: SharedState) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                if let Ok(mut s) = state.lock() {
                    s.listen_error = Some(format!("runtime: {e}"));
                }
                return;
            }
        };
        rt.block_on(backend_main(settings, state));
    });
}

async fn backend_main(settings: MasterSettings, state: SharedState) {
    let settings = Arc::new(settings);

    // Discovery responder runs regardless of the control listener.
    {
        let settings = settings.clone();
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = discovery_responder(settings, state.clone()).await {
                if let Ok(mut s) = state.lock() {
                    s.log(format!("discovery responder stopped: {e:#}"));
                }
            }
        });
    }

    if let Err(e) = control_server(settings, state.clone()).await {
        if let Ok(mut s) = state.lock() {
            s.listen_error = Some(format!("{e:#}"));
            s.listening = false;
            s.log(format!("control server failed: {e:#}"));
        }
    }
}

fn build_tls_acceptor(settings: &MasterSettings) -> Result<TlsAcceptor> {
    let certs = rustls_pemfile::certs(&mut settings.cert_pem.as_bytes())
        .collect::<std::result::Result<Vec<_>, _>>()
        .context("parse cert pem")?;
    let key = rustls_pemfile::private_key(&mut settings.key_pem.as_bytes())
        .context("parse key pem")?
        .context("no private key in pem")?;

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .context("protocol versions")?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("server cert")?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}

async fn control_server(settings: Arc<MasterSettings>, state: SharedState) -> Result<()> {
    let acceptor = build_tls_acceptor(&settings)?;
    let listener = TcpListener::bind(("0.0.0.0", settings.control_port))
        .await
        .with_context(|| format!("bind control port {}", settings.control_port))?;

    if let Ok(mut s) = state.lock() {
        s.listening = true;
        s.listen_error = None;
        s.log(format!("listening on 0.0.0.0:{}", settings.control_port));
    }

    loop {
        let (tcp, peer) = listener.accept().await?;
        let acceptor = acceptor.clone();
        let settings = settings.clone();
        let state = state.clone();
        tokio::spawn(async move {
            // Bound the unauthenticated phase so idle/slow connections can't
            // pile up.
            match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(tcp))
                .await
                .unwrap_or_else(|_| {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "handshake timed out",
                    ))
                }) {
                Ok(tls) => {
                    if let Err(e) = handle_agent(tls, peer, settings, state.clone()).await {
                        if let Ok(mut s) = state.lock() {
                            s.log(format!("agent {peer} disconnected: {e:#}"));
                        }
                    }
                }
                Err(e) => {
                    if let Ok(mut s) = state.lock() {
                        s.log(format!("TLS handshake from {peer} failed: {e}"));
                    }
                }
            }
        });
    }
}

async fn handle_agent<S>(
    tls: S,
    peer: SocketAddr,
    settings: Arc<MasterSettings>,
    state: SharedState,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    // Small frame limit until the agent has proven the enrollment secret, so
    // an unauthenticated peer can't make us allocate 64 MiB buffers.
    let mut framed = Framed::new(
        tls,
        LengthDelimitedCodec::builder()
            .max_frame_length(PRE_AUTH_MAX_FRAME)
            .new_codec(),
    );

    // First message must be Hello.
    let first = tokio::time::timeout(HANDSHAKE_TIMEOUT, framed.next())
        .await
        .context("hello timed out")?
        .context("no hello")??;
    let hello = match rmp_serde::from_slice::<AgentMsg>(&first)? {
        AgentMsg::Hello(h) => h,
        _ => anyhow::bail!("expected hello"),
    };

    if hello.protocol != PROTOCOL_VERSION {
        let _ = framed
            .send(encode(&MasterMsg::HelloAck {
                accepted: false,
                reason: "protocol version mismatch".into(),
            })?)
            .await;
        anyhow::bail!("protocol mismatch");
    }
    if !fleetview_shared::crypto::secrets_match(
        &hello.enrollment_secret,
        &settings.enrollment_secret,
    ) {
        let _ = framed
            .send(encode(&MasterMsg::HelloAck {
                accepted: false,
                reason: "enrollment secret rejected".into(),
            })?)
            .await;
        anyhow::bail!("bad enrollment secret from {peer}");
    }

    let agent_id = if hello.agent_id.trim().is_empty() {
        format!("host:{}", hello.hostname)
    } else {
        hello.agent_id.clone()
    };
    // The shared enrollment secret proves the agent belongs to this fleet; its own key proves it is the PC that
    // first enrolled under this id.
    let pinned = state
        .lock()
        .unwrap()
        .agents
        .get(&agent_id)
        .and_then(|a| a.key_hash.clone());
    if !crate::state::agent_key_ok(pinned.as_deref(), &hello.agent_key) {
        let _ = framed
            .send(encode(&MasterMsg::HelloAck {
                accepted: false,
                reason: "this PC id belongs to another agent".into(),
            })?)
            .await;
        state.lock().unwrap().log(format!(
            "refused {} ({agent_id}) from {peer}: its agent key does not match the one this id enrolled with",
            hello.hostname
        ));
        anyhow::bail!("agent key mismatch for {agent_id} from {peer}");
    }

    framed
        .send(encode(&MasterMsg::HelloAck {
            accepted: true,
            reason: String::new(),
        })?)
        .await?;
    framed
        .codec_mut()
        .set_max_frame_length(fleetview_shared::MAX_FRAME_BYTES);

    // Register the agent with a command channel.
    let (tx, mut rx) = mpsc::unbounded_channel::<MasterMsg>();

    {
        let mut s = state.lock().unwrap();
        let now = Local::now();
        let entry = s
            .agents
            .entry(agent_id.clone())
            .or_insert_with(|| AgentView::new(agent_id.clone(), hello.hostname.clone(), now));
        let previous_version =
            std::mem::replace(&mut entry.agent_version, hello.agent_version.clone());
        let updated = !previous_version.is_empty() && previous_version != hello.agent_version;
        let pending_update = entry.update_command.take().is_some();
        let version_event = if updated {
            entry.update_note = Some(format!("updated to {}", hello.agent_version));
            Some(format!(
                "{}: agent updated {previous_version} → {}",
                hello.hostname, hello.agent_version
            ))
        } else if pending_update {
            // Back on the same version: the update worker rolled back.
            entry.update_note = Some(format!(
                "update not applied (still {}); see logs\\update.log on the PC",
                hello.agent_version
            ));
            Some(format!(
                "{}: agent update did not apply (still {})",
                hello.hostname, hello.agent_version
            ))
        } else {
            None
        };
        if entry.key_hash.is_none() && !hello.agent_key.trim().is_empty() {
            entry.key_hash = Some(fleetview_shared::crypto::agent_key_hash(&hello.agent_key));
        }
        entry.online = true;
        entry.hostname = hello.hostname.clone();
        entry.addr = Some(peer);
        entry.last_seen = now;
        entry.tx = Some(tx.clone());
        s.log(format!(
            "{} ({}) connected from {peer}",
            hello.hostname, agent_id
        ));
        if let Some(ev) = version_event {
            s.log(ev);
        }
        save_known(&s);
    }

    // Ask for an initial snapshot.
    let _ = tx.send(MasterMsg::RequestTelemetry);
    let _ = tx.send(MasterMsg::RequestSoftware);

    let result = agent_loop(&mut framed, &mut rx, &agent_id, &state).await;

    // Mark offline — but only if this connection is still the current one.
    // When an agent reconnects before its old (dead) connection times out, the
    // new connection already replaced `tx`; clearing it here would show a live
    // agent as offline and drop every command sent to it.
    {
        let mut s = state.lock().unwrap();
        let mut went_offline = false;
        if let Some(a) = s.agents.get_mut(&agent_id) {
            if a.tx.as_ref().is_some_and(|cur| cur.same_channel(&tx)) {
                a.online = false;
                a.streaming = false;
                a.tx = None;
                a.last_seen = Local::now();
                went_offline = true;
            }
        }
        if went_offline {
            s.fail_pending_for(&agent_id);
            s.log(format!("{} ({agent_id}) went offline", hello.hostname));
            save_known(&s);
        }
    }

    result
}

async fn agent_loop<S>(
    framed: &mut Framed<S, LengthDelimitedCodec>,
    rx: &mut mpsc::UnboundedReceiver<MasterMsg>,
    agent_id: &str,
    state: &SharedState,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            outgoing = rx.recv() => {
                match outgoing {
                    Some(msg) => framed.send(encode(&msg)?).await?,
                    None => break,
                }
            }
            // Agents heartbeat every 20 s. A PC that lost power or network never
            // closes its TCP connection, so without this it would stay
            // "online" forever.
            incoming = tokio::time::timeout(IDLE_TIMEOUT, framed.next()) => {
                let incoming = incoming.map_err(|_| {
                    anyhow::anyhow!("no traffic for {} s", IDLE_TIMEOUT.as_secs())
                })?;
                let Some(frame) = incoming else { break };
                let frame = frame?;
                let msg: AgentMsg = rmp_serde::from_slice(&frame)?;
                apply_agent_msg(msg, agent_id, state);
            }
        }
    }
    Ok(())
}

pub(crate) fn apply_agent_msg(msg: AgentMsg, agent_id: &str, state: &SharedState) {
    let mut s = state.lock().unwrap();
    let now = Local::now();
    if let AgentMsg::CommandResult(r) = &msg {
        s.complete_command(r);
    }
    let Some(a) = s.agents.get_mut(agent_id) else {
        return;
    };
    a.last_seen = now;
    match msg {
        AgentMsg::Hello(_) => {}
        AgentMsg::Telemetry(t) => {
            a.apply_telemetry(t, now);
        }
        AgentMsg::Software(list) => {
            a.software = list;
        }
        AgentMsg::CommandResult(r) => {
            let header = format!(
                "\n$ [{}] exit={:?} ok={}\n",
                r.command_id, r.exit_code, r.success
            );
            let mut text = header;
            text.push_str(&r.stdout);
            if !r.stderr.is_empty() {
                text.push_str("\n[stderr]\n");
                text.push_str(&r.stderr);
            }
            push_bounded(&mut a.console_output, &text, CONSOLE_MAX_BYTES);
            if a.update_command.as_deref() == Some(r.command_id.as_str()) {
                if r.success {
                    a.update_note = Some("installing… the agent restarts shortly".into());
                } else {
                    a.update_command = None;
                    let why = r.stderr.lines().next().unwrap_or("").to_string();
                    a.update_note = Some(format!("update failed: {why}"));
                    let host = a.hostname.clone();
                    s.log(format!("{host}: agent update failed: {why}"));
                }
            }
        }
        AgentMsg::ScreenFrame {
            width,
            height,
            jpeg,
            ..
        } => {
            a.last_frame = Some(ScreenFrame {
                width,
                height,
                jpeg,
            });
            a.frame_seq = a.frame_seq.wrapping_add(1);
            a.frame_at = Some(now);
        }
        // One ack per 256 KiB chunk — far too many for the event list.
        AgentMsg::FileAck {
            transfer_id,
            received,
        } => {
            tracing::debug!("{}: transfer {transfer_id} {received} bytes", a.hostname);
            // Only transfers a sender registered and is waiting on.
            if let Some(v) = a.acks.get_mut(&transfer_id) {
                *v = received;
            }
        }
        AgentMsg::Heartbeat => {}
        AgentMsg::Log { level, message } => {
            let host = a.hostname.clone();
            s.log(format!("{host} [{level}]: {message}"));
        }
    }
}

// ---------------------------------------------------------------------------
// Discovery responder
// ---------------------------------------------------------------------------

async fn discovery_responder(settings: Arc<MasterSettings>, state: SharedState) -> Result<()> {
    let sock = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT))
        .await
        .with_context(|| format!("bind discovery port {DISCOVERY_PORT}"))?;
    sock.set_broadcast(true)?;

    let mut buf = vec![0u8; 8192];
    let mut announce = tokio::time::interval(Duration::from_secs(15));

    loop {
        tokio::select! {
            // Periodic unsolicited broadcast so fresh agents converge fast.
            _ = announce.tick() => {
                if let Ok(beacon) = build_beacon(&settings) {
                    let mut dg = DISCOVERY_MAGIC.to_vec();
                    dg.push(0);
                    if let Ok(body) = rmp_serde::to_vec_named(&beacon) {
                        dg.extend_from_slice(&body);
                        let target = format!("255.255.255.255:{DISCOVERY_PORT}");
                        let _ = sock.send_to(&dg, &target).await;
                    }
                }
            }
            res = sock.recv_from(&mut buf) => {
                let (n, src) = match res { Ok(v) => v, Err(_) => continue };
                if n <= DISCOVERY_MAGIC.len() + 1 { continue; }
                if &buf[..DISCOVERY_MAGIC.len()] != DISCOVERY_MAGIC { continue; }
                let body = &buf[DISCOVERY_MAGIC.len() + 1..n];
                // Only answer genuine queries (not our own beacons).
                let Ok(query) = rmp_serde::from_slice::<DiscoveryQuery>(body) else { continue };
                if query.protocol != PROTOCOL_VERSION { continue; }
                if let Ok(beacon) = build_beacon(&settings) {
                    let mut dg = DISCOVERY_MAGIC.to_vec();
                    dg.push(0);
                    if let Ok(bbody) = rmp_serde::to_vec_named(&beacon) {
                        dg.extend_from_slice(&bbody);
                        let _ = sock.send_to(&dg, src).await;
                    }
                }
                if let Ok(mut s) = state.lock() {
                    s.log(format!("discovery query from {} ({src})", query.hostname));
                }
            }
        }
    }
}

fn build_beacon(settings: &MasterSettings) -> Result<DiscoveryBeacon> {
    let issued_at_ms = Local::now().timestamp_millis();
    let bytes = DiscoveryBeacon::signing_bytes(
        PROTOCOL_VERSION,
        settings.control_port,
        &settings.cert_fingerprint,
        &settings.master_name,
        issued_at_ms,
    );
    let signature = settings.identity.sign(&bytes)?;
    Ok(DiscoveryBeacon {
        protocol: PROTOCOL_VERSION,
        control_port: settings.control_port,
        cert_fingerprint: settings.cert_fingerprint.clone(),
        master_name: settings.master_name.clone(),
        issued_at_ms,
        signature,
    })
}

fn encode(msg: &MasterMsg) -> Result<bytes::Bytes> {
    Ok(rmp_serde::to_vec_named(msg)?.into())
}
