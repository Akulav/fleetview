//! User-session helper process (`fleetview-agent helper --ipc-port N --ipc-token T`).
//!
//! Launched by the service into the interactive session. Responsibilities:
//!   * show the startup splash (transparency: the user sees the agent running),
//!   * own the always-visible tray icon,
//!   * perform screen capture on request (only the interactive session can),
//!   * show notifications the master pushes.
//!
//! It talks to the service over the authenticated loopback channel. The tray /
//! Win32 message loop runs on the main thread; a background tokio runtime runs
//! the IPC client. They communicate via a std channel.

use std::sync::mpsc;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc as tmpsc;
use tokio_util::codec::{Framed, LengthDelimitedCodec};

use crate::ipc::{HelperCommand, HelperEvent};
use crate::tray_i18n::{self, TRAY_LANG};

use windows::core::PCWSTR;
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MessageBoxW, PeekMessageW, TranslateMessage, MB_ICONINFORMATION, MB_OK,
    MB_SETFOREGROUND, MB_TOPMOST, MSG, PM_REMOVE,
};

enum UiMsg {
    Notify {
        title: String,
        body: String,
    },
    Status {
        connected: bool,
        master: String,
    },
    /// Live screen view started/stopped — reflected in the tray tooltip.
    Viewing(bool),
    /// A pushed installer is running — reflected in the tray icon.
    Busy(bool),
}

pub fn run() {
    let args = parse_args();
    let (port, token) = (args.ipc_port, args.ipc_token.clone());
    init_logging();
    tracing::info!("helper starting (ipc port {port})");

    // Start the "your screen is being viewed" indicator (shown only on demand).
    crate::overlay::init(tray_i18n::strings(TRAY_LANG).overlay_watermark);

    // Optional document-signing bridge (browser → helper → MoldSign). Only
    // started when the service provisioned e-Management settings; otherwise the
    // helper runs exactly as before.
    if let Some(bridge) = args.sign_bridge() {
        crate::signbridge::spawn(bridge);
    }

    let (ui_tx, ui_rx) = mpsc::channel::<UiMsg>();

    if port != 0 && !token.is_empty() {
        let ui_tx2 = ui_tx.clone();
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    tracing::error!("helper runtime: {e}");
                    return;
                }
            };
            rt.block_on(ipc_client(port, token, ui_tx2));
        });
    }

    // Show the splash right away on logon.
    std::thread::spawn(crate::splash::show_blocking);

    tray_loop(ui_rx);
}

#[derive(Default)]
struct HelperArgs {
    ipc_port: u16,
    ipc_token: String,
    /// Sign-bridge settings (all three required to enable the bridge).
    emgmt_origin: String,
    emgmt_validate_url: String,
    sign_bridge_token: String,
    moldsign_path: Option<String>,
}

impl HelperArgs {
    /// Build the bridge config if the service provisioned the required fields.
    fn sign_bridge(&self) -> Option<crate::signbridge::BridgeConfig> {
        if self.emgmt_origin.is_empty()
            || self.emgmt_validate_url.is_empty()
            || self.sign_bridge_token.is_empty()
        {
            return None;
        }
        Some(crate::signbridge::BridgeConfig {
            emanagement_origin: self.emgmt_origin.clone(),
            validate_url: self.emgmt_validate_url.clone(),
            bridge_token: self.sign_bridge_token.clone(),
            moldsign_exe: self.moldsign_path.clone(),
        })
    }
}

fn parse_args() -> HelperArgs {
    let args: Vec<String> = std::env::args().collect();
    let mut out = HelperArgs::default();
    let mut i = 0;
    while i < args.len() {
        let take = |i: &mut usize| -> Option<String> {
            let v = args.get(*i + 1).cloned();
            if v.is_some() {
                *i += 1;
            }
            v
        };
        match args[i].as_str() {
            "--ipc-port" => {
                if let Some(v) = take(&mut i) {
                    out.ipc_port = v.parse().unwrap_or(0);
                }
            }
            "--ipc-token" => {
                if let Some(v) = take(&mut i) {
                    out.ipc_token = v;
                }
            }
            "--emgmt-origin" => {
                if let Some(v) = take(&mut i) {
                    out.emgmt_origin = v;
                }
            }
            "--emgmt-validate-url" => {
                if let Some(v) = take(&mut i) {
                    out.emgmt_validate_url = v;
                }
            }
            "--sign-bridge-token" => {
                if let Some(v) = take(&mut i) {
                    out.sign_bridge_token = v;
                }
            }
            "--moldsign-path" => {
                if let Some(v) = take(&mut i) {
                    out.moldsign_path = Some(v);
                }
            }
            _ => {}
        }
        i += 1;
    }
    out
}

fn init_logging() {
    if let Some(dir) = dirs_local_app() {
        let logdir = dir.join("FleetView");
        let _ = std::fs::create_dir_all(&logdir);
        let Some(appender) = crate::service::rolling_log(logdir, "helper.log") else {
            return;
        };
        let _ = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(appender)
            .try_init();
    }
}

fn dirs_local_app() -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)
}

// ---------------------------------------------------------------------------
// IPC client (runs on the tokio thread)
// ---------------------------------------------------------------------------

async fn ipc_client(port: u16, token: String, ui_tx: mpsc::Sender<UiMsg>) {
    // The port and token are only valid for the service instance that launched
    // us. If the service restarts (crash, upgrade) it launches a fresh helper,
    // so once we can't reach ours for a while we exit instead of lingering as
    // an orphan with a second tray icon.
    const MAX_FAILED_ATTEMPTS: u32 = 10;
    let mut failures = 0u32;
    loop {
        match ipc_session(port, &token, &ui_tx).await {
            Ok(true) => {
                tracing::info!("ipc session closed; reconnecting");
                failures = 0;
            }
            Ok(false) => failures += 1,
            Err(e) => {
                tracing::warn!("ipc session error: {e:#}");
                failures += 1;
            }
        }
        let _ = ui_tx.send(UiMsg::Viewing(false));
        if failures >= MAX_FAILED_ATTEMPTS {
            tracing::info!("service unreachable; helper exiting");
            std::process::exit(0);
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// Returns `Ok(true)` if the service accepted us (sent at least one command)
/// before the session closed, `Ok(false)` if it closed straight away.
async fn ipc_session(port: u16, token: &str, ui_tx: &mpsc::Sender<UiMsg>) -> anyhow::Result<bool> {
    let stream = TcpStream::connect(("127.0.0.1", port)).await?;
    stream.set_nodelay(true).ok();
    let mut framed = Framed::new(
        stream,
        LengthDelimitedCodec::builder()
            .max_frame_length(fleetview_shared::MAX_FRAME_BYTES)
            .new_codec(),
    );

    // Authenticate, then say hello with the logged-in user.
    framed
        .send(bytes::Bytes::from(token.as_bytes().to_vec()))
        .await?;
    let hello = HelperEvent::Hello {
        username: current_user(),
    };
    framed
        .send(bytes::Bytes::from(rmp_serde::to_vec_named(&hello)?))
        .await?;

    // Outbound queue for screen frames produced by capture tasks.
    let (out_tx, mut out_rx) = tmpsc::channel::<HelperEvent>(16);

    // Current screen-stream task (if any).
    let mut stream_task: Option<tokio::task::JoinHandle<()>> = None;
    let mut accepted = false;
    let s = tray_i18n::strings(TRAY_LANG);

    loop {
        tokio::select! {
            Some(ev) = out_rx.recv() => {
                framed.send(bytes::Bytes::from(rmp_serde::to_vec_named(&ev)?)).await?;
            }
            incoming = framed.next() => {
                let Some(frame) = incoming else { break };
                let frame = frame?;
                accepted = true;
                let cmd: HelperCommand = rmp_serde::from_slice(&frame)?;
                match cmd {
                    HelperCommand::CaptureOnce { command_id } => {
                        // Transparency is enforced here, on the user's machine,
                        // rather than trusting the master to send a notice.
                        let _ = ui_tx.send(UiMsg::Notify {
                            title: s.view_title.into(),
                            body: s.screenshot_taken.into(),
                        });
                        crate::overlay::flash();
                        let out = out_tx.clone();
                        tokio::spawn(async move {
                            if let Some(ev) = capture_event(Some(command_id), 70).await {
                                let _ = out.send(ev).await;
                            }
                        });
                    }
                    HelperCommand::StartStream { interval_ms, jpeg_quality } => {
                        match stream_task.take() {
                            Some(t) => t.abort(),
                            None => {
                                let _ = ui_tx.send(UiMsg::Notify {
                                    title: s.view_title.into(),
                                    body: s.live_view_started.into(),
                                });
                                let _ = ui_tx.send(UiMsg::Viewing(true));
                                crate::overlay::set_viewing(true);
                            }
                        }
                        let out = out_tx.clone();
                        stream_task = Some(tokio::spawn(async move {
                            let mut tick = tokio::time::interval(
                                std::time::Duration::from_millis(interval_ms.max(200)));
                            loop {
                                tick.tick().await;
                                if let Some(ev) = capture_event(None, jpeg_quality).await {
                                    if out.send(ev).await.is_err() { break; }
                                }
                            }
                        }));
                    }
                    HelperCommand::StopStream => {
                        if let Some(t) = stream_task.take() {
                            t.abort();
                            let _ = ui_tx.send(UiMsg::Viewing(false));
                            crate::overlay::set_viewing(false);
                        }
                    }
                    HelperCommand::Notify { title, body } => {
                        let _ = ui_tx.send(UiMsg::Notify { title, body });
                    }
                    HelperCommand::Status { connected, master_name } => {
                        let _ = ui_tx.send(UiMsg::Status { connected, master: master_name });
                    }
                    HelperCommand::Busy(b) => {
                        let _ = ui_tx.send(UiMsg::Busy(b));
                    }
                }
            }
            else => break,
        }
    }

    if let Some(t) = stream_task.take() {
        t.abort();
    }
    crate::overlay::set_viewing(false);
    Ok(accepted)
}

async fn capture_event(command_id: Option<String>, quality: u8) -> Option<HelperEvent> {
    let res = tokio::task::spawn_blocking(move || crate::screenshot::capture_primary(quality))
        .await
        .ok()?;
    match res {
        Ok((width, height, jpeg)) => Some(HelperEvent::ScreenFrame {
            command_id,
            width,
            height,
            jpeg: serde_bytes::ByteBuf::from(jpeg),
        }),
        Err(e) => {
            tracing::warn!("capture failed: {e:#}");
            None
        }
    }
}

fn current_user() -> String {
    let user = std::env::var("USERNAME").unwrap_or_default();
    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    if domain.is_empty() {
        user
    } else {
        format!("{domain}\\{user}")
    }
}

// ---------------------------------------------------------------------------
// Tray + Win32 message loop (runs on the main thread)
// ---------------------------------------------------------------------------

fn tray_loop(ui_rx: mpsc::Receiver<UiMsg>) {
    use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::TrayIconBuilder;

    let s = tray_i18n::strings(TRAY_LANG);

    let menu = Menu::new();
    let status_item = MenuItem::new(s.menu_status_searching, false, None);
    let about_item = MenuItem::new(s.menu_about, true, None);
    let logs_item = MenuItem::new(s.menu_open_logs, true, None);
    let _ = menu.append(&status_item);
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&about_item);
    let _ = menu.append(&logs_item);

    let about_id = about_item.id().clone();
    let logs_id = logs_item.id().clone();

    // Right after logon the taskbar may not exist yet and creating the tray
    // icon fails. Retry instead of exiting: an exit makes the service relaunch
    // us every few seconds, flashing the splash each time.
    let icons = TrayIcons::load();
    let tray = loop {
        let builder = TrayIconBuilder::new()
            .with_tooltip(s.tooltip_searching)
            .with_menu(Box::new(menu.clone()));
        let builder = match icons.get(TrayState::Offline) {
            Some(icon) => builder.with_icon(icon),
            None => builder,
        };
        match builder.build() {
            Ok(t) => break t,
            Err(e) => {
                tracing::warn!("tray build failed (retrying): {e}");
                pump_messages();
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        }
    };

    let menu_channel = MenuEvent::receiver();
    let mut connected = false;
    let mut master = String::new();
    let mut viewing = false;
    let mut busy = false;
    let mut shown = TrayState::Offline;

    loop {
        // Pump Win32 messages so the tray icon works.
        pump_messages();

        // Tray menu clicks.
        while let Ok(ev) = menu_channel.try_recv() {
            if ev.id == about_id {
                let s = tray_i18n::strings(TRAY_LANG);
                show_message_box(s.menu_about, s.about_text);
            } else if ev.id == logs_id {
                open_logs_folder();
            }
        }

        // Commands from the IPC thread.
        let mut changed = false;
        while let Ok(msg) = ui_rx.try_recv() {
            match msg {
                UiMsg::Notify { title, body } => crate::notify::show(&title, &body),
                UiMsg::Status {
                    connected: c,
                    master: m,
                } => {
                    connected = c;
                    master = m;
                    changed = true;
                }
                UiMsg::Viewing(v) => {
                    viewing = v;
                    changed = true;
                }
                UiMsg::Busy(b) => {
                    busy = b;
                    changed = true;
                }
            }
        }
        if changed {
            let s = tray_i18n::strings(TRAY_LANG);
            // Most important first: the user must always see a screen view.
            let state = if viewing {
                TrayState::Viewing
            } else if busy {
                TrayState::Busy
            } else if connected {
                TrayState::Connected
            } else {
                TrayState::Offline
            };
            let tip = match state {
                TrayState::Viewing => s.tooltip_viewing.to_string(),
                TrayState::Busy => s.tooltip_installing.to_string(),
                TrayState::Connected => format!("{} {}", s.tooltip_connected, master),
                TrayState::Offline => s.tooltip_searching.to_string(),
            };
            let status = if busy {
                s.menu_status_installing
            } else if connected {
                s.menu_status_connected
            } else {
                s.menu_status_searching
            };
            let _ = tray.set_tooltip(Some(tip));
            status_item.set_text(status);
            if state != shown {
                if let Some(icon) = icons.get(state) {
                    let _ = tray.set_icon(Some(icon));
                }
                shown = state;
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(80));
    }
}

fn pump_messages() {
    unsafe {
        let mut msg = MSG::default();
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// What the tray icon shows (see `installer/assets/tray-*.ico`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum TrayState {
    Connected,
    Offline,
    Busy,
    Viewing,
}

impl TrayState {
    /// Icon resource id, matching `agent/build.rs`.
    fn resource_id(self) -> u16 {
        match self {
            TrayState::Connected => 101,
            TrayState::Offline => 102,
            TrayState::Busy => 103,
            TrayState::Viewing => 104,
        }
    }
}

/// The tray icons, loaded once from the exe's multi-size .ico resources at the
/// exact small-icon size for the screen's DPI (16 px at 100 %, 20 at 125 %,
/// 24 at 150 %, 32 at 200 %), so Windows never has to rescale them.
struct TrayIcons([Option<tray_icon::Icon>; 4]);

impl TrayIcons {
    fn load() -> Self {
        let px = small_icon_px();
        let load = |st: TrayState| {
            tray_icon::Icon::from_resource(st.resource_id(), Some((px, px)))
                .map_err(|e| tracing::warn!("tray icon {}: {e}", st.resource_id()))
                .ok()
        };
        Self([
            load(TrayState::Connected),
            load(TrayState::Offline),
            load(TrayState::Busy),
            load(TrayState::Viewing),
        ])
    }

    fn get(&self, st: TrayState) -> Option<tray_icon::Icon> {
        let i = match st {
            TrayState::Connected => 0,
            TrayState::Offline => 1,
            TrayState::Busy => 2,
            TrayState::Viewing => 3,
        };
        self.0[i].clone()
    }
}

/// Small-icon size in physical pixels for the system DPI. The helper itself is
/// not DPI-aware (the splash and overlay are laid out in logical pixels), so
/// the real DPI is read on a briefly DPI-aware thread context.
fn small_icon_px() -> u32 {
    use windows::Win32::UI::HiDpi::{
        GetDpiForSystem, GetSystemMetricsForDpi, SetThreadDpiAwarenessContext,
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    use windows::Win32::UI::WindowsAndMessaging::SM_CXSMICON;
    unsafe {
        let old = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let dpi = GetDpiForSystem();
        let px = GetSystemMetricsForDpi(SM_CXSMICON, dpi);
        if !old.is_invalid() {
            SetThreadDpiAwarenessContext(old);
        }
        if px > 0 {
            px as u32
        } else {
            16
        }
    }
}

fn show_message_box(title: &str, body: &str) {
    let title = to_wide(title);
    let body = to_wide(body);
    std::thread::spawn(move || unsafe {
        MessageBoxW(
            None,
            PCWSTR(body.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONINFORMATION | MB_TOPMOST | MB_SETFOREGROUND,
        );
    });
}

fn open_logs_folder() {
    if let Some(dir) = dirs_local_app() {
        let logdir = dir.join("FleetView");
        let _ = std::process::Command::new("explorer.exe")
            .arg(logdir)
            .spawn();
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
