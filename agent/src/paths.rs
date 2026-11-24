//! Well-known filesystem locations for the agent.
//!
//! Everything lives under `%ProgramData%\FleetView` so that the LocalSystem
//! service and the user-session helper can both reach it. The installer tightens
//! the ACL on this directory to SYSTEM + Administrators (see installer/agent.iss
//! and docs/SECURITY.md) because the config holds the enrollment secret.

use std::path::PathBuf;

/// Data folder override for `console` (foreground debug) runs only — see
/// [`use_console_data_dir`]. The service never sets it.
static CONSOLE_DATA_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// `fleetview-agent console` with `FLEETVIEW_DATA_DIR` set keeps its config,
/// staging and logs in that folder and leaves its ACL alone, so a developer
/// (or the end-to-end test) can run a second, unprivileged agent next to an
/// installed one. Only `main` calls this, and only in console mode.
pub fn use_console_data_dir(dir: PathBuf) {
    let _ = CONSOLE_DATA_DIR.set(dir);
}

pub fn data_dir() -> PathBuf {
    if let Some(d) = CONSOLE_DATA_DIR.get() {
        return d.clone();
    }
    // %ProgramData% is typically C:\ProgramData.
    let base = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    base.join("FleetView")
}

pub fn ensure_data_dir() -> std::io::Result<PathBuf> {
    let d = data_dir();
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

/// Remove inherited ACEs from the data directory and grant only SYSTEM and
/// Administrators. `%ProgramData%` lets ordinary users read files and create
/// files/folders in subdirectories by default, which would expose the
/// enrollment secret and let a user tamper with staged installers that the
/// service then runs as SYSTEM. Setup does this too; repeating it at service
/// start makes it robust against manual installs and ACL drift.
///
/// Only the folder itself gets explicit entries; everything inside is reset to
/// inherit them. (Applying `/inheritance:r /grant:r …(OI)(CI)F` recursively
/// with `/T` — as 0.2.0 and earlier did — strips each *file's* inherited
/// entries and then can't apply the folder-only `(OI)(CI)` grant, leaving files
/// with an empty ACL that not even SYSTEM can read: the service then can't
/// load its config and never starts the tray helper. The reset below also
/// repairs files damaged that way.)
///
/// A standard user could also have created the folder (or things inside it)
/// before FleetView was installed. They would then *own* those objects —
/// owners can always rewrite an ACL — and could have planted junctions or
/// symlinks that make the SYSTEM service write logs or stage installers
/// somewhere they control. So ownership is taken by Administrators, and
/// reparse points are deleted (never followed) before anything recursive runs.
pub fn lock_down_data_dir() {
    if CONSOLE_DATA_DIR.get().is_some() {
        return; // a developer's own folder: leave its ACL alone
    }
    let dir = data_dir();
    if is_reparse_point(&dir) {
        tracing::warn!("{} is a link; replacing it with a folder", dir.display());
        let _ = std::fs::remove_dir(&dir).or_else(|_| std::fs::remove_file(&dir));
        let _ = std::fs::create_dir_all(&dir);
    }
    let target = dir.as_os_str().to_string_lossy().to_string();
    // The folder itself first, so the user loses access before the walk.
    icacls(&target, &["/setowner", "*S-1-5-32-544", "/C", "/Q"]);
    icacls(
        &target,
        &[
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)F",     // NT AUTHORITY\SYSTEM
            "*S-1-5-32-544:(OI)(CI)F", // BUILTIN\Administrators
            "/C",
            "/Q",
        ],
    );
    remove_reparse_points(&dir, 0);
    // Children: Administrators own them; drop explicit / broken ACLs and
    // inherit from the folder. `/L` acts on a link itself, never its target.
    let children = dir.join("*").as_os_str().to_string_lossy().to_string();
    icacls(
        &children,
        &["/setowner", "*S-1-5-32-544", "/T", "/L", "/C", "/Q"],
    );
    icacls(&children, &["/reset", "/T", "/L", "/C", "/Q"]);
}

fn is_reparse_point(p: &std::path::Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(p)
        .is_ok_and(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

/// Delete every junction / symlink below `dir` (the links, not their targets).
fn remove_reparse_points(dir: &std::path::Path, depth: u32) {
    if depth > 8 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if is_reparse_point(&p) {
            tracing::warn!("removing link {} from the data folder", p.display());
            let _ = std::fs::remove_dir(&p).or_else(|_| std::fs::remove_file(&p));
        } else if e.file_type().is_ok_and(|t| t.is_dir()) {
            remove_reparse_points(&p, depth + 1);
        }
    }
}

fn icacls(target: &str, args: &[&str]) {
    let result = std::process::Command::new("icacls.exe")
        .arg(target)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match result {
        Ok(st) if st.success() => {}
        // Exit code 1 with /C just means "some file was skipped" (e.g. empty
        // folder for the wildcard); worth a note, not an error.
        Ok(st) => tracing::warn!("icacls {target} exited with {st}"),
        Err(e) => tracing::warn!("cannot run icacls on {target}: {e}"),
    }
}

/// Stable per-machine agent id (kept separate from the installer-provided config).
pub fn agent_id_path() -> PathBuf {
    data_dir().join("agent.id")
}

/// Per-agent secret the master pins to this PC's id (see `Hello::agent_key`).
pub fn agent_key_path() -> PathBuf {
    data_dir().join("agent.key")
}

pub fn config_path() -> PathBuf {
    data_dir().join("agent.config.json")
}

pub fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

/// Written by the service, read by the helper: loopback IPC endpoint + token,
/// and current connection status for the tray tooltip.
pub fn status_path() -> PathBuf {
    data_dir().join("status.json")
}

/// Directory where pushed installers/files are staged before execution.
pub fn staging_dir() -> PathBuf {
    data_dir().join("staging")
}
