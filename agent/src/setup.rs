//! Self-install, self-update and uninstall: the agent exe is its own installer.
//!
//! Modes (see `main.rs`):
//!
//! * `setup` (also: double-click, no arguments) — install, or update an
//!   existing install, from the running file. Asks for UAC when needed and
//!   reports the outcome in a message box (`--silent` for scripts: no UI,
//!   exit code only). The config comes from the trailer the master embeds
//!   ("Save agent setup"), else from `agent.config.json` next to the exe,
//!   else the already-installed config is kept (plain update).
//! * `update` — used by the master's remote update. The running agent service
//!   executes the pushed file with this argument and waits for it, so it must
//!   return at once: it copies itself out of the staging folder, starts a
//!   fully detached `update-worker` and exits. The worker then stops the
//!   service, swaps the exe and starts the new version (rolling back to the
//!   previous exe if the new one doesn't come up). It works for every agent
//!   version, because it only relies on the file push that 0.1.0 already has.
//! * `uninstall` — remove the service, the program and the secrets.
//!
//! `--set key=value` (repeatable) adjusts a few non-security config keys on
//! install/update, so the master can e.g. turn on the MoldSign bridge while
//! updating. Trust settings (keys, fingerprint, secret) are never taken from
//! the command line.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use fleetview_shared::package::{self, Version};
use serde_json::{Map, Value};

use crate::{paths, service};

/// Installed exe file name.
pub const EXE_NAME: &str = "fleetview-agent.exe";
/// Add/Remove Programs key.
const UNINSTALL_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\FleetViewAgent";
/// Key the old Inno Setup installer (≤ 0.1.x) registered; removed on upgrade.
const INNO_UNINSTALL_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{B4F3A9C1-2E7D-4B6A-9F10-7A1B2C3D4E5F}_is1";
/// Config keys `--set` may change. Everything else (master identity, pinned
/// fingerprint, enrollment secret) only comes from a master-generated config.
const SETTABLE_KEYS: &[&str] = &[
    "emanagement_url",
    "moldsign_path",
    "telemetry_interval_secs",
];

/// This build's version.
pub fn own_version() -> Version {
    Version::parse(env!("CARGO_PKG_VERSION")).expect("crate version is semver")
}

/// `C:\Program Files\FleetView Agent` (same folder the old installer used).
pub fn install_dir() -> PathBuf {
    std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
        .join("FleetView Agent")
}

fn update_dir() -> PathBuf {
    paths::data_dir().join("update")
}

#[derive(Default)]
struct Options {
    silent: bool,
    sets: Vec<(String, String)>,
}

fn parse_options(args: &[String]) -> Result<Options> {
    let mut o = Options::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--silent" | "/S" | "/s" | "/silent" | "/verysilent" => o.silent = true,
            "--set" => {
                let kv = it.next().context("--set needs key=value")?;
                let (k, v) = kv.split_once('=').context("--set needs key=value")?;
                let k = k.trim();
                if !SETTABLE_KEYS.contains(&k) {
                    bail!("--set: `{k}` cannot be changed this way");
                }
                o.sets.push((k.to_string(), v.trim().to_string()));
            }
            other => bail!("unknown option `{other}`"),
        }
    }
    Ok(o)
}

/// Re-quote arguments for `ShellExecute` / a detached re-launch.
fn join_args(args: &[String]) -> String {
    args.iter()
        .map(|a| {
            if a.is_empty() || a.contains([' ', '\t', '"']) {
                format!("\"{}\"", a.replace('"', "\\\""))
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/// `setup` / double-click. Returns the process exit code.
pub fn run_setup(args: &[String]) -> i32 {
    let opts = match parse_options(args) {
        Ok(o) => o,
        Err(e) => return report(false, &format!("{e:#}"), false),
    };
    if !is_elevated() {
        let mut relaunch = vec!["setup".to_string()];
        relaunch.extend_from_slice(args);
        return match relaunch_elevated(&relaunch) {
            Ok(()) => 0,
            Err(e) => report(
                opts.silent,
                &format!("Instalarea necesită drepturi de administrator.\n\n{e:#}"),
                false,
            ),
        };
    }
    service::init_logging("setup");
    let source = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return report(opts.silent, &format!("{e}"), false),
    };
    match install_or_update(&source, &opts) {
        Ok(summary) => report(opts.silent, &summary, true),
        Err(e) => {
            tracing::error!("setup failed: {e:#}");
            report(
                opts.silent,
                &format!("Instalarea FleetView Agent a eșuat:\n\n{e:#}"),
                false,
            )
        }
    }
}

/// `update`: hand off to a detached worker and return immediately, so the
/// agent that ran us can report success before it is stopped.
pub fn run_update(args: &[String]) -> i32 {
    if let Err(e) = parse_options(args) {
        eprintln!("{e:#}");
        return 2;
    }
    match spawn_update_worker(args) {
        Ok(v) => {
            println!(
                "FleetView agent update to {v} scheduled (from {}). The agent restarts in a few seconds.",
                own_version()
            );
            0
        }
        Err(e) => {
            eprintln!("cannot start the update: {e:#}");
            1
        }
    }
}

fn spawn_update_worker(args: &[String]) -> Result<Version> {
    use std::os::windows::process::CommandExt;

    let me = std::env::current_exe()?;
    let bytes = std::fs::read(&me).context("read update file")?;
    let (image, _) = package::split_config_trailer(&bytes);
    let v = package::find_agent_version(image).context("not a FleetView agent build")?;

    // The pushed file lives in a staging folder the agent deletes as soon as we
    // exit; run the worker from our own copy instead.
    let dir = update_dir();
    std::fs::create_dir_all(&dir)?;
    let worker = dir.join(format!("fleetview-agent-{v}-{}.exe", std::process::id()));
    std::fs::write(&worker, &bytes)?;

    // The agent captured our stdout/stderr through pipes and waits for them to
    // close. Don't let the long-lived worker inherit them, or it would wait
    // for the whole update (and kill the worker at its timeout).
    clear_std_handle_inheritance();

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let mut worker_args = vec!["update-worker".to_string()];
    worker_args.extend_from_slice(args);
    let spawn = |flags: u32| {
        std::process::Command::new(&worker)
            .args(&worker_args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(flags)
            .spawn()
    };
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    // Leave any job object the agent runs in, so stopping it can't take us down.
    spawn(base | CREATE_BREAKAWAY_FROM_JOB)
        .or_else(|_| spawn(base))
        .context("start update worker")?;
    Ok(v)
}

fn clear_std_handle_inheritance() {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{
        SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT,
    };
    let handles = [
        std::io::stdin().as_raw_handle(),
        std::io::stdout().as_raw_handle(),
        std::io::stderr().as_raw_handle(),
    ];
    for h in handles {
        if !h.is_null() {
            unsafe {
                let _ = SetHandleInformation(HANDLE(h), HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0));
            }
        }
    }
}

/// `update-worker`: the detached half of a remote update (runs as SYSTEM).
pub fn run_update_worker(args: &[String]) -> i32 {
    service::init_logging("update");
    let opts = match parse_options(args) {
        Ok(o) => o,
        Err(e) => {
            tracing::error!("update: {e:#}");
            return 2;
        }
    };
    // Give the old agent a moment to send the command result to the master.
    std::thread::sleep(Duration::from_secs(3));
    let source = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("update: {e}");
            return 1;
        }
    };
    match install_or_update(
        &source,
        &Options {
            silent: true,
            ..opts
        },
    ) {
        Ok(summary) => {
            tracing::info!("{summary}");
            0
        }
        Err(e) => {
            tracing::error!("update failed: {e:#}");
            crate::commands::audit(&format!("update FAILED: {e:#}"));
            1
        }
    }
}

/// `uninstall`.
pub fn run_uninstall(args: &[String]) -> i32 {
    let opts = match parse_options(args) {
        Ok(o) => o,
        Err(e) => return report(false, &format!("{e:#}"), false),
    };
    if !is_elevated() {
        let mut relaunch = vec!["uninstall".to_string()];
        relaunch.extend_from_slice(args);
        return match relaunch_elevated(&relaunch) {
            Ok(()) => 0,
            Err(e) => report(opts.silent, &format!("{e:#}"), false),
        };
    }
    if !opts.silent
        && !confirm(
            "FleetView Agent",
            "Dezinstalați FleetView Agent de pe acest calculator?",
        )
    {
        return 0;
    }
    service::init_logging("setup");
    match uninstall() {
        Ok(()) => report(opts.silent, "FleetView Agent a fost dezinstalat.", true),
        Err(e) => report(
            opts.silent,
            &format!("Dezinstalarea a eșuat:\n\n{e:#}"),
            false,
        ),
    }
}

// ---------------------------------------------------------------------------
// Install / update
// ---------------------------------------------------------------------------

fn install_or_update(source: &Path, opts: &Options) -> Result<String> {
    let bytes = std::fs::read(source).with_context(|| format!("read {}", source.display()))?;
    let (image, trailer) = package::split_config_trailer(&bytes);
    let new_ver =
        package::find_agent_version(image).context("this file is not a FleetView agent build")?;

    paths::ensure_data_dir().context("create data folder")?;
    paths::lock_down_data_dir();

    // --- configuration ---
    let incoming: Option<Value> = match trailer {
        Some(t) => Some(serde_json::from_slice(t).context("embedded config is not valid JSON")?),
        None => {
            let sibling = source.with_file_name("agent.config.json");
            match std::fs::read_to_string(&sibling) {
                Ok(text) => Some(
                    serde_json::from_str(text.trim_start_matches('\u{feff}'))
                        .with_context(|| format!("{} is not valid JSON", sibling.display()))?,
                ),
                Err(_) => None,
            }
        }
    };
    let existing: Option<Value> = std::fs::read_to_string(paths::config_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let merged = merge_config(existing.clone(), incoming, &opts.sets)?.context(
        "no agent configuration: create the setup file from the FleetView master \
         (Agent installer → Save agent setup) or put agent.config.json next to this file",
    )?;
    // Must be a complete, valid config before anything is replaced.
    serde_json::from_value::<crate::config::AgentConfig>(merged.clone())
        .context("agent configuration is incomplete")?;
    if existing.as_ref() != Some(&merged) {
        write_atomic(
            &paths::config_path(),
            serde_json::to_string_pretty(&merged)?.as_bytes(),
        )
        .context("write agent config")?;
    }

    // --- program files ---
    let dir = install_dir();
    let exe = dir.join(EXE_NAME);
    let old_ver = std::fs::read(&exe)
        .ok()
        .and_then(|b| package::find_agent_version(&b));
    tracing::info!(
        "installing FleetView agent {new_ver} (installed: {})",
        old_ver
            .map(|v| v.to_string())
            .unwrap_or_else(|| "none".into())
    );

    service::stop_service_and_wait(Duration::from_secs(30));
    kill_agent_processes();

    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let new_path = dir.join(format!("{EXE_NAME}.new"));
    let old_path = dir.join(format!("{EXE_NAME}.old"));
    std::fs::write(&new_path, image).context("write new exe")?;
    let _ = std::fs::remove_file(&old_path);
    let had_previous = exe.exists();
    if had_previous {
        // A running exe can be renamed (not overwritten): this also covers
        // updating from the installed file itself.
        retry(|| std::fs::rename(&exe, &old_path)).context("move the old exe aside")?;
    }
    if let Err(e) = retry(|| std::fs::rename(&new_path, &exe)) {
        if had_previous {
            let _ = std::fs::rename(&old_path, &exe);
        }
        return Err(e).context("put the new exe in place");
    }

    if let Err(e) = service::install_service_at(&exe)
        .and_then(|_| service::wait_running(Duration::from_secs(20)))
    {
        tracing::error!("new agent did not start: {e:#}");
        if had_previous {
            // Roll back to the version that worked.
            service::stop_service_and_wait(Duration::from_secs(15));
            kill_agent_processes();
            let _ = std::fs::remove_file(&exe);
            if std::fs::rename(&old_path, &exe).is_ok() {
                let _ = service::install_service_at(&exe);
                bail!("the new version did not start ({e:#}); the previous version was restored");
            }
        }
        return Err(e).context("start the FleetView service");
    }
    let _ = std::fs::remove_file(&old_path);

    write_uninstall_entry(&exe, new_ver, image.len());
    remove_inno_leftovers(&dir);

    let summary = match old_ver {
        Some(v) if v == new_ver => format!("FleetView Agent {new_ver} a fost reinstalat."),
        Some(v) => format!("FleetView Agent a fost actualizat: {v} → {new_ver}."),
        None if had_previous => format!("FleetView Agent a fost actualizat la {new_ver}."),
        None => format!("FleetView Agent {new_ver} a fost instalat și pornit."),
    };
    crate::commands::audit(&format!(
        "setup: {} → {new_ver}",
        old_ver
            .map(|v| v.to_string())
            .unwrap_or_else(|| if had_previous {
                "old".into()
            } else {
                "none".into()
            })
    ));
    tracing::info!("{summary}");
    Ok(summary)
}

/// Overlay `incoming` (a master-generated config) and `sets` onto the
/// installed config. Keys missing from `incoming` keep their installed value,
/// so local additions (e.g. `emanagement_url`) survive a reinstall.
fn merge_config(
    existing: Option<Value>,
    incoming: Option<Value>,
    sets: &[(String, String)],
) -> Result<Option<Value>> {
    let mut base = match existing {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    if let Some(inc) = incoming {
        let Value::Object(inc) = inc else {
            bail!("agent config must be a JSON object");
        };
        for (k, v) in inc {
            // The installer config always carries an empty agent_id; never let
            // it wipe a real one.
            if k == "agent_id" && v.as_str().is_some_and(|s| s.trim().is_empty()) {
                continue;
            }
            base.insert(k, v);
        }
    }
    for (k, v) in sets {
        let value = if v.is_empty() {
            Value::Null
        } else if k == "telemetry_interval_secs" {
            Value::from(
                v.parse::<u64>()
                    .context("telemetry_interval_secs must be a number")?,
            )
        } else {
            Value::String(v.clone())
        };
        base.insert(k.clone(), value);
    }
    Ok(if base.is_empty() {
        None
    } else {
        Some(Value::Object(base))
    })
}

fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)
}

fn retry<T>(mut f: impl FnMut() -> std::io::Result<T>) -> Result<T> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if Instant::now() >= deadline => return Err(e.into()),
            Err(_) => std::thread::sleep(Duration::from_millis(500)),
        }
    }
}

/// Restart the FleetView service from a detached process, so applying a config
/// change can take effect (the service loads its config at start and launches
/// the sign-bridge helper from it). We can't stop our own service inline — that
/// would kill us mid-call — so start our own exe in `restart-service` mode,
/// detached, which outlives us. It waits for the service to really stop before
/// starting it again (a fixed delay could start it while still stopping, which
/// fails and leaves the agent stopped).
pub fn schedule_service_restart() {
    use std::os::windows::process::CommandExt;
    // A foreground `console` run with its own data folder (development, the
    // end-to-end test) is not the installed service: never restart that one.
    if paths::console_mode() {
        tracing::info!("console mode: not restarting the installed service; the change applies on the next start");
        return;
    }
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let Ok(exe) = std::env::current_exe() else {
        tracing::error!("cannot restart: own exe path unknown");
        return;
    };
    let spawn = |flags: u32| {
        std::process::Command::new(&exe)
            .arg("restart-service")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(flags)
            .spawn()
    };
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    if let Err(e) = spawn(base | CREATE_BREAKAWAY_FROM_JOB).or_else(|_| spawn(base)) {
        tracing::error!("cannot start the service restarter: {e}");
    }
}

/// `restart-service`: the detached half of [`schedule_service_restart`].
pub fn run_restart_service() -> i32 {
    service::init_logging("update");
    // Let the caller send its reply to the master first.
    std::thread::sleep(Duration::from_secs(2));
    service::stop_service_and_wait(Duration::from_secs(30));
    match service::start_service() {
        Ok(()) => {
            tracing::info!("service restarted to apply a config change");
            0
        }
        Err(e) => {
            tracing::error!("service restart failed: {e:#}");
            1
        }
    }
}

/// Close tray helpers (and a service that didn't stop) so the exe is free.
/// Never kills this process.
fn kill_agent_processes() {
    let _ = std::process::Command::new("taskkill.exe")
        .args(["/F", "/IM", EXE_NAME, "/FI"])
        .arg(format!("PID ne {}", std::process::id()))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    std::thread::sleep(Duration::from_millis(800));
}

fn write_uninstall_entry(exe: &Path, v: Version, size: usize) {
    let run = || -> std::io::Result<()> {
        let hklm = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE);
        let (key, _) = hklm.create_subkey(UNINSTALL_KEY)?;
        let exe_s = exe.display().to_string();
        key.set_value("DisplayName", &"FleetView Agent")?;
        key.set_value("DisplayVersion", &v.to_string())?;
        key.set_value("Publisher", &"Akulav")?;
        key.set_value("DisplayIcon", &exe_s)?;
        key.set_value("InstallLocation", &install_dir().display().to_string())?;
        key.set_value("UninstallString", &format!("\"{exe_s}\" uninstall"))?;
        key.set_value(
            "QuietUninstallString",
            &format!("\"{exe_s}\" uninstall --silent"),
        )?;
        key.set_value("NoModify", &1u32)?;
        key.set_value("NoRepair", &1u32)?;
        key.set_value("EstimatedSize", &((size / 1024) as u32))?;
        Ok(())
    };
    if let Err(e) = run() {
        tracing::warn!("cannot write the Add/Remove Programs entry: {e}");
    }
}

/// Upgrading from the Inno Setup installer: drop its uninstaller and entry so
/// the PC doesn't list FleetView twice.
fn remove_inno_leftovers(dir: &Path) {
    let hklm = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE);
    let _ = hklm.delete_subkey_all(INNO_UNINSTALL_KEY);
    for f in ["unins000.exe", "unins000.dat", "unins000.msg", "agent.ico"] {
        let _ = std::fs::remove_file(dir.join(f));
    }
}

/// Called at service start: remove what a finished update left behind.
pub fn cleanup_leftovers() {
    let dir = install_dir();
    for f in [format!("{EXE_NAME}.old"), format!("{EXE_NAME}.new")] {
        let _ = std::fs::remove_file(dir.join(f));
    }
    if let Ok(rd) = std::fs::read_dir(update_dir()) {
        for e in rd.flatten() {
            // A worker that is still finishing holds its file open; that one
            // is removed on the next start.
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

fn uninstall() -> Result<()> {
    service::stop_service_and_wait(Duration::from_secs(30));
    if let Err(e) = service::uninstall_service() {
        tracing::warn!("remove service: {e:#}");
    }
    kill_agent_processes();
    // Secrets and transient state go; audit.log, logs\ and agent.id stay
    // (the id lets a reinstall keep the same identity on the master).
    let _ = std::fs::remove_file(paths::config_path());
    let _ = std::fs::remove_file(paths::status_path());
    let _ = std::fs::remove_dir_all(paths::staging_dir());
    let _ = std::fs::remove_dir_all(update_dir());
    let hklm = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE);
    let _ = hklm.delete_subkey_all(UNINSTALL_KEY);
    let _ = hklm.delete_subkey_all(INNO_UNINSTALL_KEY);
    crate::commands::audit("uninstall");

    // We may be running from the folder we're removing: let cmd.exe delete it
    // once this process has exited.
    let dir = install_dir();
    if dir.exists() {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("cmd.exe")
            .raw_arg(format!(
                "/d /c ping 127.0.0.1 -n 4 >nul & rmdir /s /q \"{}\"",
                dir.display()
            ))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Elevation and UI
// ---------------------------------------------------------------------------

fn is_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elev = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elev as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elev.TokenIsElevated != 0
    }
}

fn relaunch_elevated(args: &[String]) -> Result<()> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let exe = HSTRING::from(std::env::current_exe()?.as_os_str());
    let params = HSTRING::from(join_args(args));
    let r = unsafe {
        ShellExecuteW(
            None,
            w!("runas"),
            PCWSTR(exe.as_ptr()),
            PCWSTR(params.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute returns a value > 32 on success.
    if r.0 as usize > 32 {
        Ok(())
    } else {
        bail!("UAC elevation was refused or failed")
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Show the outcome (unless silent) and turn it into an exit code.
fn report(silent: bool, msg: &str, ok: bool) -> i32 {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND,
    };
    if ok {
        println!("{msg}");
    } else {
        eprintln!("{msg}");
    }
    if !silent {
        let title = to_wide("FleetView Agent");
        let body = to_wide(msg);
        let icon = if ok { MB_ICONINFORMATION } else { MB_ICONERROR };
        unsafe {
            MessageBoxW(
                None,
                PCWSTR(body.as_ptr()),
                PCWSTR(title.as_ptr()),
                MB_OK | icon | MB_SETFOREGROUND,
            );
        }
    }
    if ok {
        0
    } else {
        1
    }
}

fn confirm(title: &str, msg: &str) -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONQUESTION, MB_SETFOREGROUND, MB_YESNO,
    };
    let title = to_wide(title);
    let body = to_wide(msg);
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(body.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND,
        ) == IDYES
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merge_keeps_local_keys_and_agent_id() {
        let existing = json!({"agent_id": "abc", "enrollment_secret": "old", "emanagement_url": "https://docs"});
        let incoming = json!({"agent_id": "", "enrollment_secret": "new", "master_address": null});
        let m = merge_config(Some(existing), Some(incoming), &[])
            .unwrap()
            .unwrap();
        assert_eq!(m["agent_id"], "abc");
        assert_eq!(m["enrollment_secret"], "new");
        assert_eq!(m["emanagement_url"], "https://docs");
    }

    #[test]
    fn sets_apply_and_clear() {
        let existing = json!({"emanagement_url": "https://a"});
        let sets = vec![
            ("emanagement_url".to_string(), String::new()),
            ("telemetry_interval_secs".to_string(), "60".to_string()),
        ];
        let m = merge_config(Some(existing), None, &sets).unwrap().unwrap();
        assert!(m["emanagement_url"].is_null());
        assert_eq!(m["telemetry_interval_secs"], 60);
        assert!(merge_config(None, None, &[]).unwrap().is_none());
    }

    #[test]
    fn options_reject_trust_keys() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(parse_options(&a(&["--set", "enrollment_secret=x"])).is_err());
        let o = parse_options(&a(&["--silent", "--set", "emanagement_url=https://x"])).unwrap();
        assert!(o.silent);
        assert_eq!(o.sets[0].1, "https://x");
    }
}
