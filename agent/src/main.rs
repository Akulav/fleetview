//! FleetView agent entry point.
//!
//! A single executable that is also its own installer and updater. Modes,
//! selected by the first argument:
//!
//!   (none) | setup       Install, or update an existing install, from this
//!                        file (double-click; asks for UAC). `--silent` for
//!                        scripts. See `setup.rs`.
//!   update               Remote update pushed by the master: hands off to a
//!                        detached `update-worker` and returns immediately.
//!   uninstall            Remove the service, the program and the secrets.
//!   run-service          Service control dispatcher (how the SCM starts us).
//!   install              Only register the service at this exe's location
//!                        (development; `setup` is the real installer).
//!   console              Run the service worker in the foreground (debugging).
//!   helper               User-session helper: tray icon, splash, screen capture.
//!   version              Print version and exit.
//!
//! The service runs as LocalSystem (always elevated) and performs all network,
//! telemetry and command work. It launches `helper` into the active user
//! session so the tray icon, startup splash and screen capture run where the
//! user can see them and where the desktop is actually reachable.

// On release builds the service has no console; the helper is a GUI app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod helper;
mod inventory;
mod ipc;
mod net;
mod notify;
mod overlay;
mod paths;
mod screenshot;
mod service;
mod session;
mod setup;
mod signbridge;
mod splash;
mod telemetry;
mod tls;
mod tray_i18n;

use std::ffi::OsString;

const SERVICE_NAME: &str = "FleetViewAgent";
const SERVICE_DISPLAY: &str = "FleetView Agent";
const SERVICE_DESC: &str =
    "FleetView remote management agent (telemetry, software deployment). Made by Akulav.";

/// Version marker the master and the updater read from the file on disk
/// (format: see `fleetview_shared::package`).
static VERSION_MARKER: &str = concat!("FLEETVIEW_AGENT_VERSION=", env!("CARGO_PKG_VERSION"), "\0");

fn main() {
    // Keep the marker in the binary whatever the optimiser thinks of it.
    std::hint::black_box(VERSION_MARKER.as_ptr());

    let args: Vec<String> = std::env::args().skip(1).collect();
    // The service is registered with an explicit `run-service`, so a bare
    // start (double-click) is the installer.
    let mode = args.first().map(|s| s.as_str()).unwrap_or("setup");
    let rest = args.get(1..).unwrap_or(&[]);

    match mode {
        "version" | "--version" | "-V" => {
            println!("FleetView Agent {}", env!("CARGO_PKG_VERSION"));
        }
        "setup" => std::process::exit(setup::run_setup(rest)),
        // Installer-style switch on its own: silent install/update.
        "/S" | "/s" | "/silent" | "/verysilent" | "--silent" => {
            std::process::exit(setup::run_setup(&args))
        }
        "update" => std::process::exit(setup::run_update(rest)),
        "update-worker" => std::process::exit(setup::run_update_worker(rest)),
        "restart-service" => std::process::exit(setup::run_restart_service()),
        "install" => {
            if let Err(e) = service::install_service() {
                eprintln!("install failed: {e:#}");
                std::process::exit(1);
            }
            println!("Service installed.");
        }
        "uninstall" => std::process::exit(setup::run_uninstall(rest)),
        "console" => {
            // Foreground run for debugging (Ctrl-C to stop).
            if let Some(dir) = std::env::var_os("FLEETVIEW_DATA_DIR").filter(|d| !d.is_empty()) {
                paths::use_console_data_dir(std::path::PathBuf::from(dir));
            }
            service::init_logging("console");
            let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
            let shutdown = service::shutdown_token();
            let sd = shutdown.clone();
            rt.spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                sd.cancel();
            });
            rt.block_on(service::worker_main(shutdown));
        }
        "helper" => {
            helper::run();
        }
        "run-service" => {
            // Hand control to the SCM dispatcher. This blocks until the service
            // stops. If we were NOT started by the SCM this returns an error,
            // which we report for convenience.
            if let Err(e) = run_as_service() {
                eprintln!(
                    "Not started by the Service Control Manager ({e}).\n\
                     Run `fleetview-agent setup` to install it, or \
                     `fleetview-agent console` to run in the foreground."
                );
                std::process::exit(1);
            }
        }
        other => {
            eprintln!("unknown mode: {other}");
            std::process::exit(2);
        }
    }
}

fn run_as_service() -> anyhow::Result<()> {
    windows_service::service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .map_err(|e| anyhow::anyhow!(e))
}

// The SCM calls into this symbol; it must have this exact signature.
windows_service::define_windows_service!(ffi_service_main, service_main);

fn service_main(_args: Vec<OsString>) {
    if let Err(e) = service::run() {
        tracing::error!("service failed: {e:#}");
    }
}
