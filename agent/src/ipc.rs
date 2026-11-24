//! Authenticated loopback IPC between the LocalSystem service and the
//! user-session helper process.
//!
//! The service listens on `127.0.0.1:<random port>` and passes the port plus a
//! random token to the helper on its command line (see `session.rs`). The
//! helper connects and proves itself with the token. After that:
//!
//!   service -> helper : [`HelperCommand`]  (capture a screenshot, stream,
//!                        notify the user, ...)
//!   helper  -> service: [`HelperEvent`]    (screen frames, the logged-in user)
//!
//! Only loopback is used, so frames never touch the network here; the service
//! relays them to the master over TLS.

use std::sync::Arc;

use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, Mutex};
use tokio_util::codec::{Framed, LengthDelimitedCodec};
use tokio_util::sync::CancellationToken;

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HelperCommand {
    CaptureOnce {
        command_id: String,
    },
    StartStream {
        interval_ms: u64,
        jpeg_quality: u8,
    },
    StopStream,
    Notify {
        title: String,
        body: String,
    },
    /// Connection status pushed to the helper so it can update the tray tooltip.
    Status {
        connected: bool,
        master_name: String,
    },
    /// A pushed installer started (true) or the last one finished (false);
    /// the tray shows its "busy" icon meanwhile.
    Busy(bool),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HelperEvent {
    Hello {
        username: String,
    },
    ScreenFrame {
        command_id: Option<String>,
        width: u32,
        height: u32,
        jpeg: serde_bytes::ByteBuf,
    },
    Log {
        level: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusFile {
    pub ipc_port: u16,
    pub connected: bool,
    pub master_name: String,
}

pub struct HubInner {
    pub to_helper: broadcast::Sender<HelperCommand>,
    pub from_helper: broadcast::Sender<HelperEvent>,
    pub token: String,
    pub user: Mutex<Option<String>>,
    pub master_name: Mutex<String>,
    pub connected: std::sync::atomic::AtomicBool,
    pub port: std::sync::atomic::AtomicU16,
}

#[derive(Clone)]
pub struct Hub(pub Arc<HubInner>);

impl Hub {
    pub fn new() -> Self {
        let (to_helper, _) = broadcast::channel(64);
        let (from_helper, _) = broadcast::channel(256);
        Hub(Arc::new(HubInner {
            to_helper,
            from_helper,
            token: fleetview_shared::crypto::random_secret(),
            user: Mutex::new(None),
            master_name: Mutex::new(String::new()),
            connected: std::sync::atomic::AtomicBool::new(false),
            port: std::sync::atomic::AtomicU16::new(0),
        }))
    }

    pub fn send_to_helper(&self, cmd: HelperCommand) {
        let _ = self.0.to_helper.send(cmd);
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<HelperEvent> {
        self.0.from_helper.subscribe()
    }

    pub async fn set_connected(&self, connected: bool, master_name: &str) {
        self.0
            .connected
            .store(connected, std::sync::atomic::Ordering::Relaxed);
        *self.0.master_name.lock().await = master_name.to_string();
        let _ = self.write_status().await;
        // Push status to the helper so it can refresh its tray tooltip.
        self.send_to_helper(HelperCommand::Status {
            connected,
            master_name: master_name.to_string(),
        });
    }

    pub fn port(&self) -> u16 {
        self.0.port.load(std::sync::atomic::Ordering::Relaxed)
    }

    async fn write_status(&self) -> anyhow::Result<()> {
        let status = StatusFile {
            ipc_port: self.port(),
            connected: self.0.connected.load(std::sync::atomic::Ordering::Relaxed),
            master_name: self.0.master_name.lock().await.clone(),
        };
        write_status(&status)
    }
}

pub fn write_status(status: &StatusFile) -> anyhow::Result<()> {
    paths::ensure_data_dir()?;
    std::fs::write(paths::status_path(), serde_json::to_string_pretty(status)?)?;
    Ok(())
}

/// Run the loopback IPC server until shutdown.
pub async fn serve(hub: Hub, shutdown: CancellationToken) -> anyhow::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .context("bind loopback ipc")?;
    let port = listener.local_addr()?.port();
    hub.0.port.store(port, std::sync::atomic::Ordering::Relaxed);

    // Publish the port + token so the helper can connect.
    write_status(&StatusFile {
        ipc_port: port,
        connected: false,
        master_name: String::new(),
    })?;
    tracing::info!("ipc listening on 127.0.0.1:{port}");

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => {
                let (stream, _peer) = match accepted {
                    Ok(v) => v,
                    Err(e) => { tracing::warn!("ipc accept: {e}"); continue; }
                };
                let hub = hub.clone();
                let sd = shutdown.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_helper(stream, hub, sd).await {
                        tracing::warn!("helper ipc connection ended: {e:#}");
                    }
                });
            }
        }
    }
    Ok(())
}

async fn handle_helper(
    stream: TcpStream,
    hub: Hub,
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    stream.set_nodelay(true).ok();
    // Any local process can connect to the loopback port, so keep the
    // unauthenticated phase small and short.
    let mut framed = Framed::new(
        stream,
        LengthDelimitedCodec::builder()
            .max_frame_length(1024)
            .new_codec(),
    );

    // First frame must be the auth token.
    let first = tokio::time::timeout(std::time::Duration::from_secs(10), framed.next())
        .await
        .context("helper auth timed out")?
        .context("helper closed before auth")??;
    let presented = String::from_utf8_lossy(&first);
    if !fleetview_shared::crypto::secrets_match(presented.trim(), &hub.0.token) {
        anyhow::bail!("helper presented bad token");
    }
    tracing::info!("helper authenticated");
    framed
        .codec_mut()
        .set_max_frame_length(fleetview_shared::MAX_FRAME_BYTES);

    let mut rx_cmd = hub.0.to_helper.subscribe();
    // Status is only broadcast on change, so a helper that attaches after we
    // connected to the master would otherwise show "searching" forever. Send
    // it the current state directly (the helper shows the splash by itself).
    let status = HelperCommand::Status {
        connected: hub.0.connected.load(std::sync::atomic::Ordering::Relaxed),
        master_name: hub.0.master_name.lock().await.clone(),
    };
    framed
        .send(bytes::Bytes::from(rmp_serde::to_vec_named(&status)?))
        .await?;

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            cmd = rx_cmd.recv() => {
                match cmd {
                    Ok(cmd) => {
                        let bytes = rmp_serde::to_vec_named(&cmd)?;
                        framed.send(bytes::Bytes::from(bytes)).await?;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
            incoming = framed.next() => {
                let Some(frame) = incoming else { break };
                let frame = frame?;
                let event: HelperEvent = rmp_serde::from_slice(&frame)?;
                if let HelperEvent::Hello { username } = &event {
                    *hub.0.user.lock().await = Some(username.clone());
                }
                let _ = hub.0.from_helper.send(event);
            }
        }
    }
    Ok(())
}
