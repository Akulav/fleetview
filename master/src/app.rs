//! egui desktop UI for the master. English only (per requirement).
//!
//! Layout: a navigation sidebar (pages + quick device list), a page area, a
//! status bar, modal dialogs and toasts. Every action sent to PCs becomes a
//! [`crate::state::Job`] so its per-PC results can be followed in the Jobs page.

mod activity;
mod dashboard;
mod deploy;
mod device;
mod devices;
mod dialogs;
mod jobs;
mod software;
mod standards;

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};
use eframe::egui::{self, vec2, Color32, RichText};

use fleetview_shared::protocol::{ConfigUpdate, MasterMsg, RunSpec};

use crate::agentpkg::{self, AgentPackage, UpdateState};
use crate::policy::{self, AppItem, Policy};
use crate::prefs::Prefs;
use crate::settings::MasterSettings;
use crate::state::{JobKind, SharedState, TargetStatus};
use crate::ui::theme::{self, semibold, tint, Palette};
use crate::ui::widgets as w;

#[derive(Clone, PartialEq, Eq)]
pub enum Page {
    Dashboard,
    Devices,
    Software,
    Jobs,
    Activity,
    Standards,
    Deploy,
    Device(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum DeviceTab {
    Overview,
    Software,
    Terminal,
    Screen,
    History,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StatusFilter {
    All,
    Online,
    Offline,
    Attention,
    Outdated,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Host,
    User,
    Cpu,
    Mem,
    Disk,
    Uptime,
    LastSeen,
    Version,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PowerKind {
    Restart,
    Shutdown,
    Abort,
}

impl PowerKind {
    fn label(self) -> &'static str {
        match self {
            PowerKind::Restart => "Restart",
            PowerKind::Shutdown => "Shut down",
            PowerKind::Abort => "Cancel pending restart/shutdown",
        }
    }

    /// Restart/shutdown give the user 60 s and a visible reason; an admin can
    /// still cancel with `Abort`.
    fn script(self) -> String {
        match self {
            PowerKind::Restart => {
                "shutdown.exe /r /t 60 /c \"This PC will restart in 1 minute (requested by IT). Please save your work.\"; exit $LASTEXITCODE".into()
            }
            PowerKind::Shutdown => {
                "shutdown.exe /s /t 60 /c \"This PC will shut down in 1 minute (requested by IT). Please save your work.\"; exit $LASTEXITCODE".into()
            }
            PowerKind::Abort => "shutdown.exe /a; exit $LASTEXITCODE".into(),
        }
    }
}

/// An action that needs an explicit confirmation before it is sent.
#[derive(Clone)]
pub enum Action {
    RunScript {
        script: String,
        ids: Vec<String>,
    },
    /// Push these installers to each PC, one after another.
    InstallApps {
        apps: Vec<AppItem>,
        ids: Vec<String>,
        /// Record them as the fleet's app package standard.
        package: bool,
    },
    /// (agent id, new name) per PC.
    Rename {
        names: Vec<(String, String)>,
        restart: bool,
    },
    SetAdmin {
        ids: Vec<String>,
    },
    Wallpaper {
        ids: Vec<String>,
    },
    InstallUrl {
        url: String,
        ids: Vec<String>,
    },
    Update {
        ids: Vec<String>,
    },
    Power {
        kind: PowerKind,
        ids: Vec<String>,
    },
    Uninstall {
        name: String,
        targets: Vec<(String, String)>,
    },
    SetConfig {
        ids: Vec<String>,
        updates: Vec<ConfigUpdate>,
    },
    Notify {
        title: String,
        body: String,
        ids: Vec<String>,
    },
    Forget {
        ids: Vec<String>,
    },
}

impl Action {
    fn ids(&self) -> Vec<String> {
        match self {
            Action::RunScript { ids, .. }
            | Action::InstallApps { ids, .. }
            | Action::SetAdmin { ids }
            | Action::Wallpaper { ids }
            | Action::InstallUrl { ids, .. }
            | Action::Update { ids }
            | Action::Power { ids, .. }
            | Action::SetConfig { ids, .. }
            | Action::Notify { ids, .. }
            | Action::Forget { ids } => ids.clone(),
            Action::Uninstall { targets, .. } => targets.iter().map(|t| t.0.clone()).collect(),
            Action::Rename { names, .. } => names.iter().map(|t| t.0.clone()).collect(),
        }
    }
}

/// Bulk-action editors opened from the selection bar.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ComposerKind {
    Script,
    Install,
    Notify,
    Config,
    Tags,
    Rename,
}

pub struct Composer {
    pub kind: ComposerKind,
    pub ids: Vec<String>,
}

pub struct Toast {
    text: String,
    color: Color32,
    until: Instant,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Info,
    Warn,
    Crit,
}

#[derive(Clone)]
pub struct Alert {
    pub severity: Severity,
    pub text: String,
}

/// One frame's view of an agent, read under a single lock.
#[derive(Clone)]
pub struct DeviceRow {
    pub id: String,
    pub host: String,
    pub online: bool,
    pub user: String,
    pub ips: Vec<String>,
    pub os: String,
    pub cpu: Option<f32>,
    pub mem: Option<f32>,
    pub disk: Option<(String, f32)>,
    pub uptime: Option<u64>,
    pub last_seen: DateTime<Local>,
    pub version: String,
    pub update: UpdateState,
    pub update_note: Option<String>,
    pub updating: bool,
    pub streaming: bool,
    pub tags: Vec<String>,
    pub alerts: Vec<Alert>,
    pub cpu_hist: Vec<f32>,
}

impl DeviceRow {
    pub fn worst(&self) -> Option<Severity> {
        self.alerts.iter().map(|a| a.severity).max()
    }
}

pub struct App {
    state: SharedState,
    settings: MasterSettings,
    prefs: Prefs,
    pal: Palette,
    page: Page,
    /// Pages visited before the current one (for Back).
    back: Vec<Page>,
    device_tab: DeviceTab,

    // per-agent screen textures: agent_id -> (frame_seq, texture)
    textures: HashMap<String, (u64, egui::TextureHandle)>,
    screen_fit: bool,

    // Device list
    checked: BTreeSet<String>,
    search: String,
    sidebar_search: String,
    status_filter: StatusFilter,
    tag_filter: Option<String>,
    sort: (SortKey, bool),
    focus_search: bool,

    // Terminal
    ps_input: String,
    ps_history: Vec<String>,
    ps_history_pos: Option<usize>,
    snippet_name: String,

    // Inputs shared by dialogs
    notify_title: String,
    notify_body: String,
    software_filter: String,
    fleet_sw_filter: String,
    fleet_sw_open: Option<String>,
    install_args: String,
    install_is_msi: bool,
    url_input: String,
    /// Installers queued in the Install composer.
    install_queue: Vec<AppItem>,
    rename_input: String,

    // Fleet standards
    policy: Policy,
    admin_pw_confirm: String,
    show_pw: bool,
    standards_status: String,
    /// (agent id, standard key) -> last automatic attempt.
    auto_attempts: HashMap<(String, String), Instant>,
    last_auto_check: Instant,
    stream_fps: u32,
    tag_input: String,
    activity_filter: String,
    selected_job: Option<u64>,
    job_filter_failed: bool,

    // Deploy page
    config_text: String,
    config_master_addr: String,
    emanagement_input: String,
    config_status: String,
    rc: [ConfigField; 5],

    // agent package used for setups and remote updates
    package: Option<AgentPackage>,
    package_error: String,

    // dialogs
    confirm: Option<Action>,
    composer: Option<Composer>,
    toasts: Vec<Toast>,
}

/// One row in the remote-config editor: a key, whether to apply it, and its
/// value. The key names match the agent's `REMOTE_SETTABLE_KEYS`.
#[derive(Clone)]
pub struct ConfigField {
    key: &'static str,
    label: &'static str,
    hint: &'static str,
    apply: bool,
    value: String,
}

fn default_config_fields() -> [ConfigField; 5] {
    let f = |key, label, hint| ConfigField {
        key,
        label,
        hint,
        apply: false,
        value: String::new(),
    };
    [
        f(
            "emanagement_url",
            "e-Management URL",
            "http://docs.ansc.local:3080 — turns on the MoldSign bridge; empty = off",
        ),
        f(
            "master_address",
            "Master address",
            "host:port to skip discovery; empty = auto-discover",
        ),
        f(
            "discovery_targets",
            "Discovery targets",
            "extra broadcast addresses, comma-separated, e.g. 192.168.20.255:48621",
        ),
        f(
            "telemetry_interval_secs",
            "Telemetry interval (s)",
            "seconds between telemetry reports, e.g. 30",
        ),
        f(
            "moldsign_path",
            "MoldSign path",
            "override SignDesktop.exe location; empty = auto",
        ),
    ]
}

impl App {
    pub fn new(
        cc: &eframe::CreationContext<'_>,
        state: SharedState,
        settings: MasterSettings,
    ) -> Self {
        let prefs = Prefs::load();
        let pal = Palette::new(prefs.dark);
        theme::install_fonts(&cc.egui_ctx);
        theme::apply(&cc.egui_ctx, &pal);
        let emanagement_input = settings.emanagement_url.clone();
        let config_text = settings
            .agent_config_json(None)
            .unwrap_or_else(|e| format!("error: {e}"));
        let policy = Policy::load();
        let mut app = Self {
            state,
            settings,
            prefs,
            pal,
            page: Page::Dashboard,
            back: Vec::new(),
            device_tab: DeviceTab::Overview,
            textures: HashMap::new(),
            screen_fit: true,
            checked: BTreeSet::new(),
            search: String::new(),
            sidebar_search: String::new(),
            status_filter: StatusFilter::All,
            tag_filter: None,
            sort: (SortKey::Host, true),
            focus_search: false,
            ps_input: String::new(),
            ps_history: Vec::new(),
            ps_history_pos: None,
            snippet_name: String::new(),
            notify_title: "Message from IT".into(),
            notify_body: String::new(),
            software_filter: String::new(),
            fleet_sw_filter: String::new(),
            fleet_sw_open: None,
            install_args: "/S".into(),
            install_is_msi: false,
            url_input: String::new(),
            install_queue: Vec::new(),
            rename_input: String::new(),
            admin_pw_confirm: policy.admin_password.clone(),
            policy,
            show_pw: false,
            standards_status: String::new(),
            auto_attempts: HashMap::new(),
            last_auto_check: Instant::now(),
            stream_fps: 2,
            tag_input: String::new(),
            activity_filter: String::new(),
            selected_job: None,
            job_filter_failed: false,
            config_text,
            config_master_addr: String::new(),
            emanagement_input,
            config_status: String::new(),
            rc: default_config_fields(),
            package: None,
            package_error: String::new(),
            confirm: None,
            composer: None,
            toasts: Vec::new(),
        };
        app.load_package();
        // Demo mode can open on a given page (used for screenshots).
        if crate::demo::requested() {
            if let Ok(p) = std::env::var("FLEETVIEW_DEMO_PAGE") {
                let (page, tab) = p.split_once(':').unwrap_or((p.as_str(), ""));
                app.page = match page {
                    "devices" => Page::Devices,
                    "software" => {
                        app.fleet_sw_open = Some("google chrome".into());
                        Page::Software
                    }
                    "jobs" => Page::Jobs,
                    "activity" => Page::Activity,
                    "standards" => Page::Standards,
                    "deploy" => Page::Deploy,
                    "device" => Page::Device("demo-01".into()),
                    _ => Page::Dashboard,
                };
                app.device_tab = match tab {
                    "software" => DeviceTab::Software,
                    "terminal" => DeviceTab::Terminal,
                    "screen" => DeviceTab::Screen,
                    "history" => DeviceTab::History,
                    _ => DeviceTab::Overview,
                };
                if page == "devices" {
                    app.checked.insert("demo-00".into());
                    app.checked.insert("demo-01".into());
                }
            }
            if std::env::var_os("FLEETVIEW_DEMO_LIGHT").is_some() {
                app.set_dark(&cc.egui_ctx, false);
            }
        }
        app
    }

    // -----------------------------------------------------------------------
    // Navigation & feedback
    // -----------------------------------------------------------------------

    fn go(&mut self, page: Page) {
        if self.page != page {
            let prev = std::mem::replace(&mut self.page, page);
            self.back.push(prev);
            if self.back.len() > 50 {
                self.back.remove(0);
            }
        }
    }

    fn open_device(&mut self, id: &str) {
        self.go(Page::Device(id.to_string()));
    }

    fn go_back(&mut self) {
        if let Some(p) = self.back.pop() {
            self.page = p;
        }
    }

    fn toast(&mut self, text: impl Into<String>) {
        self.toast_colored(text, self.pal.accent);
    }

    fn toast_err(&mut self, text: impl Into<String>) {
        self.toast_colored(text, self.pal.red);
    }

    fn toast_colored(&mut self, text: impl Into<String>, color: Color32) {
        self.toasts.push(Toast {
            text: text.into(),
            color,
            until: Instant::now() + Duration::from_secs(4),
        });
        if self.toasts.len() > 5 {
            self.toasts.remove(0);
        }
    }

    fn set_dark(&mut self, ctx: &egui::Context, dark: bool) {
        self.prefs.dark = dark;
        self.pal = Palette::new(dark);
        theme::apply(ctx, &self.pal);
        self.prefs.save();
    }

    // -----------------------------------------------------------------------
    // Package
    // -----------------------------------------------------------------------

    /// (Re)load the agent package from the configured path or the default.
    fn load_package(&mut self) {
        let path = if self.settings.agent_package_path.trim().is_empty() {
            AgentPackage::default_path()
        } else {
            std::path::PathBuf::from(self.settings.agent_package_path.trim())
        };
        match AgentPackage::load(&path) {
            Ok(p) => {
                self.package = Some(p);
                self.package_error.clear();
            }
            Err(e) => {
                self.package = None;
                self.package_error = format!("{e:#}");
            }
        }
    }

    fn choose_package(&mut self) {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("FleetView agent", &["exe"])
            .pick_file()
        else {
            return;
        };
        self.settings.agent_package_path = path.display().to_string();
        let _ = self.settings.save();
        self.load_package();
        match &self.package {
            Some(p) => {
                let msg = format!("Loaded agent package {}", p.version);
                self.toast(msg);
            }
            None => self.toast_err("That file is not a FleetView agent"),
        }
    }

    fn update_state_of(&self, agent_version: &str) -> UpdateState {
        match &self.package {
            Some(p) => agentpkg::update_state(agent_version, &p.version),
            None => UpdateState::Unknown,
        }
    }

    // -----------------------------------------------------------------------
    // Snapshot
    // -----------------------------------------------------------------------

    /// Read every agent once for this frame, with its alerts.
    fn snapshot(&self) -> Vec<DeviceRow> {
        let s = self.state.lock().unwrap();
        let now = Local::now();
        s.agents
            .values()
            .map(|a| {
                let t = a.telemetry.as_ref();
                let cpu = t.filter(|_| a.online).map(|t| t.cpu_usage_pct);
                let mem = a.mem_pct().filter(|_| a.online);
                let disk = a.worst_disk();
                let update = self.update_state_of(&a.agent_version);
                let mut alerts = Vec::new();
                if let Some((mount, pct)) = &disk {
                    if *pct >= self.prefs.disk_warn_pct {
                        alerts.push(Alert {
                            severity: if *pct >= 97.0 {
                                Severity::Crit
                            } else {
                                Severity::Warn
                            },
                            text: format!("Disk {mount} {pct:.0}% full"),
                        });
                    }
                }
                if let Some(m) = mem {
                    if m >= self.prefs.mem_warn_pct {
                        alerts.push(Alert {
                            severity: Severity::Warn,
                            text: format!("Memory at {m:.0}%"),
                        });
                    }
                }
                if let Some(c) = cpu {
                    // Sustained: the last three samples all high.
                    let recent: Vec<f32> = a.history.iter().rev().take(3).map(|s| s.cpu).collect();
                    if c >= self.prefs.cpu_warn_pct
                        && recent.len() == 3
                        && recent.iter().all(|v| *v >= self.prefs.cpu_warn_pct)
                    {
                        alerts.push(Alert {
                            severity: Severity::Warn,
                            text: format!("CPU sustained at {c:.0}%"),
                        });
                    }
                }
                if !a.online && self.prefs.stale_days > 0 {
                    let days = (now - a.last_seen).num_days();
                    if days >= self.prefs.stale_days as i64 {
                        alerts.push(Alert {
                            severity: Severity::Info,
                            text: format!("Offline for {days} days"),
                        });
                    }
                }
                if a.online && update == UpdateState::Outdated {
                    alerts.push(Alert {
                        severity: Severity::Info,
                        text: format!("Agent {} is outdated", a.agent_version),
                    });
                }
                if let Some(n) = &a.update_note {
                    if n.contains("failed") || n.contains("not applied") {
                        alerts.push(Alert {
                            severity: Severity::Warn,
                            text: format!("Agent update: {n}"),
                        });
                    }
                }
                DeviceRow {
                    id: a.agent_id.clone(),
                    host: a.hostname.clone(),
                    online: a.online,
                    user: a.last_user.clone().unwrap_or_default(),
                    ips: a.last_ips.clone(),
                    os: short_os(&a.last_os),
                    cpu,
                    mem,
                    disk,
                    uptime: t.filter(|_| a.online).map(|t| t.uptime_secs),
                    last_seen: a.last_seen,
                    version: a.agent_version.clone(),
                    update,
                    update_note: a.update_note.clone(),
                    updating: a.update_command.is_some(),
                    streaming: a.streaming,
                    tags: a.tags.clone(),
                    alerts,
                    cpu_hist: a.history.iter().map(|s| s.cpu).collect(),
                }
            })
            .collect()
    }

    fn all_tags(rows: &[DeviceRow]) -> Vec<String> {
        let mut t: Vec<String> = rows.iter().flat_map(|r| r.tags.clone()).collect();
        t.sort_by_key(|s| s.to_lowercase());
        t.dedup();
        t
    }

    // -----------------------------------------------------------------------
    // Sending
    // -----------------------------------------------------------------------

    /// Unique id per command. A bare millisecond timestamp collided when one
    /// click sent several messages (e.g. "Run on ALL", or a file push).
    pub fn new_command_id() -> String {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("{}-{n}", chrono::Local::now().timestamp_millis())
    }

    fn send_to(&self, id: &str, msg: MasterMsg) -> bool {
        let s = self.state.lock().unwrap();
        s.agents.get(id).is_some_and(|a| a.send(msg))
    }

    fn online_ids(&self) -> Vec<String> {
        let s = self.state.lock().unwrap();
        s.agents
            .values()
            .filter(|a| a.online)
            .map(|a| a.agent_id.clone())
            .collect()
    }

    /// Of `ids`, the online ones.
    fn only_online(&self, ids: &[String]) -> Vec<String> {
        let s = self.state.lock().unwrap();
        ids.iter()
            .filter(|id| s.agents.get(*id).is_some_and(|a| a.online))
            .cloned()
            .collect()
    }

    /// Send one command message per agent under a new job; `make` builds the
    /// message from the command id. Offline agents are marked skipped.
    fn dispatch(
        &mut self,
        kind: JobKind,
        title: String,
        detail: String,
        ids: &[String],
        make: impl Fn(String) -> MasterMsg,
    ) -> u64 {
        self.dispatch_tracked(kind, title, detail, ids, make, None, false)
    }

    /// [`Self::dispatch`], optionally recording a fleet standard (`key` at
    /// `rev`) on each PC whose command succeeds; `quiet` skips the toast
    /// (automatic runs).
    #[allow(clippy::too_many_arguments)]
    fn dispatch_tracked(
        &mut self,
        kind: JobKind,
        title: String,
        detail: String,
        ids: &[String],
        make: impl Fn(String) -> MasterMsg,
        mark: Option<(&str, &str)>,
        quiet: bool,
    ) -> u64 {
        let mut s = self.state.lock().unwrap();
        let job = s.create_job(kind, title.clone(), detail, ids);
        let mut sent = 0;
        for id in ids {
            let cid = Self::new_command_id();
            let ok = s.agents.get(id).is_some_and(|a| a.send(make(cid.clone())));
            if ok {
                s.attach_command(job, id, &cid);
                if let Some((key, rev)) = mark {
                    s.mark_on_success(&cid, id, key, rev);
                }
                sent += 1;
            } else {
                s.finish_target(job, id, TargetStatus::Skipped, "offline — not sent");
            }
        }
        s.log(format!("{title}: sent to {sent} of {} PC(s)", ids.len()));
        drop(s);
        if !quiet {
            self.toast(format!("{title} → {sent} PC(s)"));
        }
        job
    }

    /// Set the standard local admin account on `ids`.
    fn apply_admin(&mut self, ids: &[String], quiet: bool) {
        if !self.policy.admin_ready() || ids.is_empty() {
            return;
        }
        let user = self.policy.admin_user.trim().to_string();
        let script = policy::admin_script(
            &user,
            &self.policy.admin_password,
            self.policy.admin_demote_others,
        );
        let rev = self.policy.admin_rev.to_string();
        self.dispatch_tracked(
            JobKind::Standard,
            format!("Admin account: {user}"),
            format!(
                "Create/reset local admin “{user}” (password hidden){}",
                if self.policy.admin_demote_others {
                    "; remove other local accounts from Administrators"
                } else {
                    ""
                }
            ),
            ids,
            |cid| MasterMsg::RunPowerShell {
                command_id: cid,
                script: script.clone(),
            },
            Some((policy::KEY_ADMIN, &rev)),
            quiet,
        );
    }

    /// Set the standard desktop background on `ids`. The image is shrunk to
    /// at most 4K and re-encoded as JPEG, since it travels inside the script
    /// once per PC.
    fn apply_wallpaper(&mut self, ids: &[String], quiet: bool) {
        if ids.is_empty() {
            return;
        }
        let path = self.policy.wallpaper_path.clone();
        let image = match wallpaper_jpeg(&path) {
            Ok(b) => b,
            Err(e) => {
                self.toast_err(format!("Background image: {e}"));
                return;
            }
        };
        let script = policy::wallpaper_script(
            &image,
            "jpg",
            self.policy.wallpaper_style,
            self.policy.wallpaper_lock,
        );
        let rev = self.policy.wallpaper_rev.to_string();
        let name = std::path::Path::new(&path)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        self.dispatch_tracked(
            JobKind::Standard,
            format!("Desktop background: {}", truncate(&name, 36)),
            format!(
                "{path} ({}{})",
                self.policy.wallpaper_style.label(),
                if self.policy.wallpaper_lock {
                    ", locked"
                } else {
                    ""
                }
            ),
            ids,
            |cid| MasterMsg::RunPowerShell {
                command_id: cid,
                script: script.clone(),
            },
            Some((policy::KEY_WALLPAPER, &rev)),
            quiet,
        );
    }

    fn rename_pcs(&mut self, names: Vec<(String, String)>, restart: bool) {
        let ids: Vec<String> = names.iter().map(|n| n.0.clone()).collect();
        let mut s = self.state.lock().unwrap();
        let title = if names.len() == 1 {
            format!("Rename to {}", names[0].1)
        } else {
            format!("Rename {} PCs", names.len())
        };
        let detail = names
            .iter()
            .map(|(id, n)| format!("{} → {n}", s.hostname_of(id)))
            .collect::<Vec<_>>()
            .join(", ");
        let job = s.create_job(JobKind::Standard, title, detail, &ids);
        let mut sent = 0;
        for (id, name) in &names {
            let cid = Self::new_command_id();
            let ok = s.agents.get(id).is_some_and(|a| {
                a.send(MasterMsg::RunPowerShell {
                    command_id: cid.clone(),
                    script: policy::rename_script(name, restart),
                })
            });
            if ok {
                s.attach_command(job, id, &cid);
                sent += 1;
            } else {
                s.finish_target(job, id, TargetStatus::Skipped, "offline — not sent");
            }
        }
        s.log(format!("rename sent to {sent} PC(s)"));
        drop(s);
        self.toast(format!("Renaming {sent} PC(s)"));
    }

    /// Fleet standards that are switched to automatic are applied to every
    /// online PC that doesn't have the current version yet — including PCs
    /// that enroll later. A failed attempt is retried after 30 minutes.
    fn auto_apply(&mut self) {
        if self.last_auto_check.elapsed() < Duration::from_secs(10) {
            return;
        }
        self.last_auto_check = Instant::now();
        let p = &self.policy;
        let admin = p.admin_auto && p.admin_ready();
        let wall = p.wallpaper_auto && p.wallpaper_ready();
        let apps: Vec<(AppItem, String)> = if p.apps_auto {
            p.apps
                .iter()
                .filter_map(|a| a.revision().map(|r| (a.clone(), r)))
                .collect()
        } else {
            Vec::new()
        };
        if !admin && !wall && apps.is_empty() {
            return;
        }
        let admin_rev = p.admin_rev.to_string();
        let wall_rev = p.wallpaper_rev.to_string();

        let mut need_admin = Vec::new();
        let mut need_wall = Vec::new();
        let mut need_apps: Vec<(String, Vec<AppItem>)> = Vec::new();
        {
            let s = self.state.lock().unwrap();
            for a in s.agents.values() {
                if !a.online || a.tx.is_none() || a.telemetry.is_none() {
                    continue;
                }
                let id = &a.agent_id;
                let due = |key: &str, rev: &str| {
                    a.applied.get(key).map(String::as_str) != Some(rev)
                        && !s.mark_in_flight(id, key)
                };
                if admin && due(policy::KEY_ADMIN, &admin_rev) {
                    need_admin.push(id.clone());
                }
                if wall && due(policy::KEY_WALLPAPER, &wall_rev) {
                    need_wall.push(id.clone());
                }
                // Wait for the software list so installed apps are skipped.
                if !apps.is_empty() && !a.software.is_empty() {
                    let missing: Vec<AppItem> = apps
                        .iter()
                        .filter(|(app, rev)| due(&app.key(), rev))
                        .map(|(app, _)| app.clone())
                        .collect();
                    if !missing.is_empty() {
                        need_apps.push((id.clone(), missing));
                    }
                }
            }
        }
        let now = Instant::now();
        let mut attempt = |id: &str, key: &str| -> bool {
            let k = (id.to_string(), key.to_string());
            match self.auto_attempts.get(&k) {
                Some(t) if now.duration_since(*t) < Duration::from_secs(30 * 60) => false,
                _ => {
                    self.auto_attempts.insert(k, now);
                    true
                }
            }
        };
        let need_admin: Vec<String> = need_admin
            .into_iter()
            .filter(|id| attempt(id, policy::KEY_ADMIN))
            .collect();
        let need_wall: Vec<String> = need_wall
            .into_iter()
            .filter(|id| attempt(id, policy::KEY_WALLPAPER))
            .collect();
        let need_apps: Vec<(String, Vec<AppItem>)> = need_apps
            .into_iter()
            .filter_map(|(id, list)| {
                let list: Vec<AppItem> = list
                    .into_iter()
                    .filter(|a| attempt(&id, &a.key()))
                    .collect();
                (!list.is_empty()).then_some((id, list))
            })
            .collect();
        if !need_admin.is_empty() {
            self.apply_admin(&need_admin, true);
        }
        if !need_wall.is_empty() {
            self.apply_wallpaper(&need_wall, true);
        }
        for (id, list) in need_apps {
            self.push_apps(list, vec![id], JobKind::Standard, true, true);
        }
    }

    fn run_script(&mut self, script: String, ids: &[String]) -> u64 {
        let first = script.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
        let title = format!("PowerShell: {}", truncate(first.trim(), 48));
        self.dispatch(JobKind::Script, title, script.clone(), ids, |cid| {
            MasterMsg::RunPowerShell {
                command_id: cid,
                script: script.clone(),
            }
        })
    }

    fn update_agents(&mut self, ids: Vec<String>) {
        let Some(p) = &self.package else { return };
        let version = p.version;
        let job = {
            let mut s = self.state.lock().unwrap();
            s.create_job(
                JobKind::Update,
                format!("Agent update to {version}"),
                p.path.display().to_string(),
                &ids,
            )
        };
        let n = ids.len();
        agentpkg::start_update(
            self.state.clone(),
            p,
            ids,
            &self.settings.emanagement_url,
            Self::new_command_id,
            Some(job),
        );
        self.toast(format!("Updating {n} agent(s) to {version}"));
    }

    /// Push installers to PCs: one job per installer, installed one after
    /// another on each PC (so MSIs never collide), all PCs in parallel.
    /// With `track`, each install is recorded as part of the app package
    /// standard.
    fn push_apps(
        &mut self,
        apps: Vec<AppItem>,
        ids: Vec<String>,
        kind: JobKind,
        track: bool,
        quiet: bool,
    ) {
        if apps.is_empty() || ids.is_empty() {
            return;
        }
        let jobs: Vec<u64> = {
            let mut s = self.state.lock().unwrap();
            apps.iter()
                .map(|a| {
                    s.create_job(
                        kind,
                        format!("Install {}", truncate(&a.file_name(), 40)),
                        format!("{}  {}", a.path, a.args),
                        &ids,
                    )
                })
                .collect()
        };
        if !quiet {
            self.toast(format!(
                "Installing {} app(s) on {} PC(s)",
                apps.len(),
                ids.len()
            ));
        }
        crate::packages::start(
            self.state.clone(),
            apps,
            jobs,
            ids,
            track,
            App::new_command_id,
        );
    }

    fn install_url_on(&mut self, url: String, ids: &[String]) {
        let is_msi = self.install_is_msi;
        let args = split_args(&self.install_args);
        let name = url.rsplit('/').next().unwrap_or(&url).to_string();
        self.dispatch(
            JobKind::Install,
            format!("Install {}", truncate(&name, 40)),
            url.clone(),
            ids,
            |cid| MasterMsg::InstallFromUrl {
                command_id: cid.clone(),
                url: url.clone(),
                run: RunSpec {
                    command_id: cid,
                    args: args.clone(),
                    is_msi,
                },
            },
        );
    }

    fn notify(&mut self, title: String, body: String, ids: &[String]) {
        let mut s = self.state.lock().unwrap();
        let job = s.create_job(
            JobKind::Notify,
            format!("Message: {}", truncate(&body, 40)),
            body.clone(),
            ids,
        );
        let mut sent = 0;
        for id in ids {
            let ok = s.agents.get(id).is_some_and(|a| {
                a.send(MasterMsg::NotifyUser {
                    title: title.clone(),
                    body: body.clone(),
                })
            });
            if ok {
                sent += 1;
                s.finish_target(job, id, TargetStatus::Succeeded, "delivered to the agent");
            } else {
                s.finish_target(job, id, TargetStatus::Skipped, "offline — not sent");
            }
        }
        s.log(format!("message sent to {sent} PC(s)"));
        drop(s);
        self.toast(format!("Message sent to {sent} PC(s)"));
    }

    fn set_config_on(&mut self, ids: &[String], updates: Vec<ConfigUpdate>) {
        if updates.is_empty() || ids.is_empty() {
            return;
        }
        let keys: Vec<String> = updates.iter().map(|u| u.key.clone()).collect();
        self.dispatch(
            JobKind::Config,
            format!("Config: {}", keys.join(", ")),
            keys.join(", "),
            ids,
            |cid| MasterMsg::SetConfig {
                command_id: cid,
                updates: updates.clone(),
            },
        );
    }

    fn wake(&mut self, ids: &[String]) {
        let targets: Vec<(String, Vec<String>, Vec<String>)> = {
            let s = self.state.lock().unwrap();
            ids.iter()
                .filter_map(|id| s.agents.get(id))
                .map(|a| (a.hostname.clone(), a.last_macs.clone(), a.last_ips.clone()))
                .collect()
        };
        let mut woke = 0;
        let mut no_mac = Vec::new();
        for (host, macs, ips) in targets {
            match crate::wol::wake(&macs, &ips) {
                Ok(n) if n > 0 => woke += 1,
                _ => no_mac.push(host),
            }
        }
        if let Ok(mut s) = self.state.lock() {
            s.log(format!("Wake-on-LAN sent for {woke} PC(s)"));
        }
        if no_mac.is_empty() {
            self.toast(format!("Wake-on-LAN packet sent to {woke} PC(s)"));
        } else {
            self.toast_err(format!(
                "No known MAC for: {}",
                truncate(&no_mac.join(", "), 60)
            ));
        }
    }

    fn forget(&mut self, ids: &[String]) {
        let mut s = self.state.lock().unwrap();
        let mut n = 0;
        for id in ids {
            if s.agents.get(id).is_some_and(|a| !a.online) {
                s.agents.remove(id);
                n += 1;
            }
        }
        crate::state::save_known(&s);
        s.log(format!("removed {n} offline PC(s) from the list"));
        drop(s);
        for id in ids {
            self.checked.remove(id);
            self.textures.remove(id);
        }
        if let Page::Device(id) = &self.page {
            if ids.contains(id) {
                self.page = Page::Devices;
            }
        }
        self.toast(format!("Removed {n} PC(s)"));
    }

    fn set_tags(&mut self, ids: &[String], add: &[String], remove: &[String]) {
        let mut s = self.state.lock().unwrap();
        for id in ids {
            if let Some(a) = s.agents.get_mut(id) {
                for t in add {
                    if !a.tags.iter().any(|x| x.eq_ignore_ascii_case(t)) {
                        a.tags.push(t.clone());
                    }
                }
                a.tags
                    .retain(|x| !remove.iter().any(|r| r.eq_ignore_ascii_case(x)));
                a.tags.sort_by_key(|t| t.to_lowercase());
            }
        }
        crate::state::save_known(&s);
    }

    /// Run a confirmed action.
    fn execute(&mut self, action: Action) {
        match action {
            Action::RunScript { script, ids } => {
                self.remember_script(&script);
                let job = self.run_script(script, &ids);
                if ids.len() > 1 {
                    self.selected_job = Some(job);
                }
            }
            Action::InstallApps { apps, ids, package } => {
                self.push_apps(apps, ids, JobKind::Install, package, false)
            }
            Action::Rename { names, restart } => self.rename_pcs(names, restart),
            Action::SetAdmin { ids } => self.apply_admin(&ids, false),
            Action::Wallpaper { ids } => self.apply_wallpaper(&ids, false),
            Action::InstallUrl { url, ids } => self.install_url_on(url, &ids),
            Action::Update { ids } => self.update_agents(ids),
            Action::Power { kind, ids } => {
                let script = kind.script();
                self.dispatch(
                    JobKind::Power,
                    kind.label().to_string(),
                    script.clone(),
                    &ids,
                    |cid| MasterMsg::RunPowerShell {
                        command_id: cid,
                        script: script.clone(),
                    },
                );
            }
            Action::Uninstall { name, targets } => {
                let mut s = self.state.lock().unwrap();
                let ids: Vec<String> = targets.iter().map(|t| t.0.clone()).collect();
                let job = s.create_job(
                    JobKind::Uninstall,
                    format!("Uninstall {name}"),
                    name.clone(),
                    &ids,
                );
                let mut sent = 0;
                for (id, uninstall) in &targets {
                    let cid = Self::new_command_id();
                    let ok = s.agents.get(id).is_some_and(|a| {
                        a.send(MasterMsg::RunPowerShell {
                            command_id: cid.clone(),
                            script: uninstall_script(uninstall),
                        })
                    });
                    if ok {
                        s.attach_command(job, id, &cid);
                        sent += 1;
                    } else {
                        s.finish_target(job, id, TargetStatus::Skipped, "offline — not sent");
                    }
                }
                s.log(format!("uninstall {name} sent to {sent} PC(s)"));
                drop(s);
                self.toast(format!("Uninstalling {name} on {sent} PC(s)"));
            }
            Action::SetConfig { ids, updates } => self.set_config_on(&ids, updates),
            Action::Notify { title, body, ids } => self.notify(title, body, &ids),
            Action::Forget { ids } => self.forget(&ids),
        }
    }

    fn remember_script(&mut self, script: &str) {
        let s = script.trim().to_string();
        if s.is_empty() {
            return;
        }
        self.ps_history.retain(|h| *h != s);
        self.ps_history.push(s);
        if self.ps_history.len() > 50 {
            self.ps_history.remove(0);
        }
        self.ps_history_pos = None;
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Keep the UI live for telemetry/screen updates.
        ctx.request_repaint_after(Duration::from_millis(250));

        self.shortcuts(ctx);
        self.auto_apply();
        let rows = self.snapshot();

        self.sidebar(ctx, &rows);
        self.status_bar(ctx, &rows);
        egui::CentralPanel::default()
            .frame(
                egui::Frame::none()
                    .fill(self.pal.bg)
                    .inner_margin(egui::Margin::symmetric(26.0, 20.0)),
            )
            .show(ctx, |ui| match self.page.clone() {
                Page::Dashboard => self.page_dashboard(ui, &rows),
                Page::Devices => self.page_devices(ui, &rows),
                Page::Software => self.page_software(ui, &rows),
                Page::Jobs => self.page_jobs(ui),
                Page::Activity => self.page_activity(ui),
                Page::Standards => self.page_standards(ui, &rows),
                Page::Deploy => self.page_deploy(ui),
                Page::Device(id) => self.page_device(ui, &id, &rows),
            });

        if self.composer.is_some() {
            self.composer_window(ctx, &rows);
        }
        if self.confirm.is_some() {
            self.confirm_window(ctx);
        }
        self.draw_toasts(ctx);
    }
}

impl App {
    fn shortcuts(&mut self, ctx: &egui::Context) {
        let (find, back, esc) = ctx.input(|i| {
            (
                i.modifiers.command && i.key_pressed(egui::Key::F),
                (i.modifiers.alt && i.key_pressed(egui::Key::ArrowLeft))
                    || i.pointer.button_pressed(egui::PointerButton::Extra1),
                i.key_pressed(egui::Key::Escape),
            )
        });
        if find {
            if !matches!(self.page, Page::Devices | Page::Software | Page::Activity) {
                self.go(Page::Devices);
            }
            self.focus_search = true;
        }
        if back && self.confirm.is_none() && self.composer.is_none() {
            self.go_back();
        }
        if esc {
            if self.confirm.is_some() {
                self.confirm = None;
            } else if self.composer.is_some() {
                self.composer = None;
            }
        }
    }

    fn sidebar(&mut self, ctx: &egui::Context, rows: &[DeviceRow]) {
        let pal = self.pal;
        egui::SidePanel::left("nav")
            .resizable(false)
            .exact_width(236.0)
            .frame(
                egui::Frame::none()
                    .fill(pal.panel)
                    .stroke(egui::Stroke::new(1.0_f32, pal.border))
                    .inner_margin(egui::Margin::symmetric(12.0, 14.0)),
            )
            .show(ctx, |ui| {
                // Brand
                ui.horizontal(|ui| {
                    let (r, _) = ui.allocate_exact_size(vec2(32.0, 32.0), egui::Sense::hover());
                    ui.painter()
                        .rect_filled(r, egui::Rounding::same(9.0), pal.accent);
                    ui.painter().text(
                        r.center(),
                        egui::Align2::CENTER_CENTER,
                        "F",
                        semibold(18.0),
                        Color32::WHITE,
                    );
                    ui.vertical(|ui| {
                        ui.spacing_mut().item_spacing.y = 0.0;
                        ui.label(
                            RichText::new("FleetView")
                                .font(semibold(16.0))
                                .color(pal.text),
                        );
                        ui.label(
                            RichText::new(format!("Master v{}", env!("CARGO_PKG_VERSION")))
                                .size(11.5)
                                .color(pal.text_faint),
                        );
                    });
                });
                ui.add_space(14.0);

                let online = rows.iter().filter(|r| r.online).count();
                let attention = rows
                    .iter()
                    .filter(|r| r.worst().is_some_and(|s| s >= Severity::Warn))
                    .count();
                let running = self.state.lock().unwrap().running_jobs();
                let on_device = matches!(self.page, Page::Device(_));

                type NavItem<'a> = (&'a str, &'a str, Page, Option<(String, Color32)>);
                let items: [NavItem; 7] = [
                    (
                        "🏠",
                        "Dashboard",
                        Page::Dashboard,
                        (attention > 0).then(|| (attention.to_string(), pal.amber)),
                    ),
                    (
                        "🖥",
                        "Devices",
                        Page::Devices,
                        Some((format!("{online}/{}", rows.len()), pal.green)),
                    ),
                    ("📦", "Software", Page::Software, None),
                    (
                        "⚡",
                        "Jobs",
                        Page::Jobs,
                        (running > 0).then(|| (format!("{running} running"), pal.blue)),
                    ),
                    ("📜", "Activity", Page::Activity, None),
                    ("📐", "Standards", Page::Standards, None),
                    ("🚀", "Deploy & settings", Page::Deploy, None),
                ];
                for (icon, label, page, badge) in items {
                    let selected = self.page == page || (on_device && page == Page::Devices);
                    if w::nav_item(ui, &pal, icon, label, selected, badge).clicked() {
                        self.go(page);
                    }
                }

                ui.add_space(12.0);
                ui.separator();
                ui.add_space(4.0);
                w::card_title(ui, &pal, "Quick find");
                ui.add_space(2.0);
                w::search_box(
                    ui,
                    &mut self.sidebar_search,
                    "Host, user or IP",
                    ui.available_width(),
                );
                ui.add_space(4.0);

                let q = self.sidebar_search.to_lowercase();
                let mut list: Vec<&DeviceRow> = rows
                    .iter()
                    .filter(|r| q.is_empty() || row_matches(r, &q))
                    .collect();
                list.sort_by(|a, b| {
                    b.online
                        .cmp(&a.online)
                        .then_with(|| a.host.to_lowercase().cmp(&b.host.to_lowercase()))
                });
                let footer_h = 36.0;
                egui::ScrollArea::vertical()
                    .max_height(ui.available_height() - footer_h)
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        for r in list {
                            let selected = self.page == Page::Device(r.id.clone());
                            if self.device_list_item(ui, r, selected).clicked() {
                                self.open_device(&r.id);
                            }
                        }
                        if rows.is_empty() {
                            w::faint(ui, &pal, "No PCs yet. Install the agent from Deploy.");
                        }
                    });

                // Footer: theme toggle
                ui.with_layout(egui::Layout::bottom_up(egui::Align::LEFT), |ui| {
                    ui.horizontal(|ui| {
                        let dark = self.prefs.dark;
                        let label = if dark {
                            "☀  Light mode"
                        } else {
                            "🌙  Dark mode"
                        };
                        if w::ghost(ui, label).clicked() {
                            self.set_dark(ui.ctx(), !dark);
                        }
                    });
                });
            });
    }

    fn device_list_item(&self, ui: &mut egui::Ui, r: &DeviceRow, selected: bool) -> egui::Response {
        let pal = &self.pal;
        let width = ui.available_width();
        let (rect, resp) = ui.allocate_exact_size(vec2(width, 40.0), egui::Sense::click());
        if ui.is_rect_visible(rect) {
            let p = ui.painter();
            if selected {
                p.rect_filled(rect, egui::Rounding::same(8.0), tint(pal.accent, 34));
            } else if resp.hovered() {
                p.rect_filled(rect, egui::Rounding::same(8.0), pal.surface2);
            }
            let color = if r.online { pal.green } else { pal.text_faint };
            let dot = egui::pos2(rect.left() + 12.0, rect.center().y);
            if r.online {
                p.circle_filled(dot, 6.0, tint(color, 45));
            }
            p.circle_filled(dot, 3.6, color);
            p.text(
                egui::pos2(rect.left() + 26.0, rect.top() + 12.0),
                egui::Align2::LEFT_CENTER,
                truncate(&r.host, 22),
                semibold(13.0),
                if r.online { pal.text } else { pal.text_dim },
            );
            let sub = if r.online {
                match (r.cpu, r.user.is_empty()) {
                    (Some(c), false) => format!("{} · {c:.0}% CPU", truncate(&r.user, 14)),
                    (Some(c), true) => format!("{c:.0}% CPU"),
                    _ => "online".into(),
                }
            } else {
                format!("seen {}", w::fmt_ago(r.last_seen))
            };
            p.text(
                egui::pos2(rect.left() + 26.0, rect.top() + 28.0),
                egui::Align2::LEFT_CENTER,
                sub,
                egui::FontId::proportional(11.5),
                pal.text_faint,
            );
            // Right-side markers
            let mut x = rect.right() - 8.0;
            if r.streaming {
                let g = p.layout_no_wrap("LIVE".into(), semibold(9.5), pal.red);
                let br = egui::Rect::from_min_size(
                    egui::pos2(x - g.size().x - 8.0, rect.center().y - 8.0),
                    vec2(g.size().x + 8.0, 16.0),
                );
                p.rect_filled(br, egui::Rounding::same(4.0), tint(pal.red, 40));
                p.galley(br.center() - g.size() / 2.0, g, pal.red);
                x = br.left() - 4.0;
            }
            if let Some(sev) = r.worst() {
                if sev >= Severity::Warn {
                    let c = if sev == Severity::Crit {
                        pal.red
                    } else {
                        pal.amber
                    };
                    p.text(
                        egui::pos2(x, rect.center().y),
                        egui::Align2::RIGHT_CENTER,
                        "⚠",
                        egui::FontId::proportional(13.0),
                        c,
                    );
                }
            }
        }
        let tip = if r.alerts.is_empty() {
            r.ips.join(", ")
        } else {
            r.alerts
                .iter()
                .map(|a| a.text.clone())
                .collect::<Vec<_>>()
                .join("\n")
        };
        if tip.is_empty() {
            resp
        } else {
            resp.on_hover_text(tip)
        }
    }

    fn status_bar(&mut self, ctx: &egui::Context, rows: &[DeviceRow]) {
        let pal = self.pal;
        let (listening, err, name, last_event) = {
            let s = self.state.lock().unwrap();
            (
                s.listening,
                s.listen_error.clone(),
                s.master_name.clone(),
                s.events.front().cloned(),
            )
        };
        egui::TopBottomPanel::bottom("status")
            .exact_height(28.0)
            .frame(
                egui::Frame::none()
                    .fill(pal.panel)
                    .stroke(egui::Stroke::new(1.0_f32, pal.border))
                    .inner_margin(egui::Margin::symmetric(12.0, 4.0)),
            )
            .show(ctx, |ui| {
                ui.horizontal_centered(|ui| {
                    ui.spacing_mut().item_spacing.x = 14.0;
                    if listening {
                        w::dot(ui, pal.green, true);
                        ui.label(
                            RichText::new(format!(
                                "Listening on port {}",
                                self.settings.control_port
                            ))
                            .size(12.0)
                            .color(pal.text_dim),
                        );
                    } else {
                        w::dot(ui, pal.red, true);
                        ui.label(
                            RichText::new(err.unwrap_or_else(|| "Not listening".into()))
                                .size(12.0)
                                .color(pal.red),
                        );
                    }
                    ui.label(RichText::new(name).size(12.0).color(pal.text_faint));
                    let online = rows.iter().filter(|r| r.online).count();
                    ui.label(
                        RichText::new(format!("{online} online · {} known", rows.len()))
                            .size(12.0)
                            .color(pal.text_faint),
                    );
                    match &self.package {
                        Some(p) => ui.label(
                            RichText::new(format!("Agent package {}", p.version))
                                .size(12.0)
                                .color(pal.text_faint),
                        ),
                        None => ui.label(
                            RichText::new("No agent package")
                                .size(12.0)
                                .color(pal.amber),
                        ),
                    };
                    if let Some((at, msg)) = last_event {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let r = ui.add(
                                egui::Label::new(
                                    RichText::new(format!(
                                        "{}  {}",
                                        at.format("%H:%M:%S"),
                                        truncate(&msg, 80)
                                    ))
                                    .size(12.0)
                                    .color(pal.text_faint),
                                )
                                .sense(egui::Sense::click()),
                            );
                            if r.on_hover_text("Open the activity log").clicked() {
                                self.go(Page::Activity);
                            }
                        });
                    }
                });
            });
    }

    fn draw_toasts(&mut self, ctx: &egui::Context) {
        let now = Instant::now();
        self.toasts.retain(|t| t.until > now);
        if self.toasts.is_empty() {
            return;
        }
        let pal = self.pal;
        egui::Area::new(egui::Id::new("toasts"))
            .anchor(egui::Align2::RIGHT_BOTTOM, vec2(-18.0, -42.0))
            .order(egui::Order::Tooltip)
            .interactable(false)
            .show(ctx, |ui| {
                for t in &self.toasts {
                    egui::Frame::none()
                        .fill(pal.surface)
                        .stroke(egui::Stroke::new(1.0_f32, pal.border))
                        .rounding(egui::Rounding::same(8.0))
                        .shadow(ctx.style().visuals.popup_shadow)
                        .inner_margin(egui::Margin::symmetric(14.0, 10.0))
                        .show(ui, |ui| {
                            ui.set_min_width(260.0);
                            ui.horizontal(|ui| {
                                let (r, _) =
                                    ui.allocate_exact_size(vec2(4.0, 18.0), egui::Sense::hover());
                                ui.painter()
                                    .rect_filled(r, egui::Rounding::same(2.0), t.color);
                                ui.label(RichText::new(&t.text).color(pal.text));
                            });
                        });
                    ui.add_space(6.0);
                }
            });
        ctx.request_repaint_after(Duration::from_millis(200));
    }

    /// Small header used by every page: title, subtitle, and right-aligned
    /// actions.
    fn page_header(
        &mut self,
        ui: &mut egui::Ui,
        title: &str,
        subtitle: &str,
        actions: impl FnOnce(&mut Self, &mut egui::Ui),
    ) {
        let pal = self.pal;
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                w::heading(ui, &pal, title);
                if !subtitle.is_empty() {
                    w::subtle(ui, &pal, subtitle);
                }
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                actions(self, ui);
            });
        });
        ui.add_space(14.0);
    }

    fn version_text(&self, version: &str, update: UpdateState) -> RichText {
        let text = if version.is_empty() { "—" } else { version };
        match update {
            UpdateState::Outdated => RichText::new(format!("{text} ⬆")).color(self.pal.amber),
            UpdateState::Current => RichText::new(text).color(self.pal.green),
            _ => RichText::new(text).color(self.pal.text_dim),
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

pub fn row_matches(r: &DeviceRow, q: &str) -> bool {
    r.host.to_lowercase().contains(q)
        || r.user.to_lowercase().contains(q)
        || r.ips.iter().any(|i| i.contains(q))
        || r.os.to_lowercase().contains(q)
        || r.tags.iter().any(|t| t.to_lowercase().contains(q))
}

/// "Microsoft Windows 11 Pro 10.0.22631" -> "Windows 11 Pro"
pub fn short_os(os: &str) -> String {
    let s = os.trim().trim_start_matches("Microsoft ").to_string();
    // Drop a trailing build number.
    match s.rsplit_once(' ') {
        Some((head, tail))
            if tail.contains('.')
                && tail.chars().all(|c| c.is_ascii_digit() || c == '.')
                && !head.is_empty() =>
        {
            head.to_string()
        }
        _ => s,
    }
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

/// Read a wallpaper image, shrink it to fit 3840×2160 and re-encode it as a
/// JPEG (quality 90) — a few hundred KB to ~2 MB, whatever the source was.
fn wallpaper_jpeg(path: &str) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    if meta.len() > 64 * 1024 * 1024 {
        return Err("the image file is larger than 64 MB".into());
    }
    let img = image::open(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let img = if img.width() > 3840 || img.height() > 2160 {
        img.resize(3840, 2160, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
        .encode_image(&img.to_rgb8())
        .map_err(|e| format!("cannot encode: {e}"))?;
    if out.len() as u64 > policy::MAX_WALLPAPER_BYTES {
        return Err("the image is too large even after compression".into());
    }
    Ok(out)
}

fn split_args(s: &str) -> Vec<String> {
    s.split_whitespace().map(|x| x.to_string()).collect()
}

/// Quote a CSV field.
pub fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Quote a value as a PowerShell single-quoted string literal.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Split an UninstallString into (executable, remaining arguments).
fn split_command(cmd: &str) -> (String, String) {
    let cmd = cmd.trim();
    if let Some(rest) = cmd.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return (rest[..end].to_string(), rest[end + 1..].trim().to_string());
        }
        return (rest.to_string(), String::new());
    }
    // Unquoted: the path may contain spaces, so cut after ".exe" if present.
    let lower = cmd.to_lowercase();
    if let Some(i) = lower.find(".exe") {
        let end = i + 4;
        return (cmd[..end].to_string(), cmd[end..].trim().to_string());
    }
    match cmd.split_once(' ') {
        Some((exe, args)) => (exe.to_string(), args.trim().to_string()),
        None => (cmd.to_string(), String::new()),
    }
}

/// Best-effort silent uninstall from an uninstall string. The generated
/// script waits for the uninstaller and exits with its exit code, so the
/// console shows real success/failure.
fn uninstall_script(uninstall: &str) -> String {
    let (exe, mut args) = split_command(uninstall);
    let exe_name = std::path::Path::new(&exe)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let (file, args) = if exe_name.starts_with("msiexec") {
        // Use the product code if there is one; otherwise just switch /I → /X.
        match (uninstall.find('{'), uninstall.find('}')) {
            (Some(a), Some(b)) if b > a => (
                "msiexec.exe".to_string(),
                format!("/X {} /qn /norestart", &uninstall[a..=b]),
            ),
            _ => {
                let mut a = args.replacen("/I", "/X", 1).replacen("/i", "/X", 1);
                if !a.to_lowercase().contains("/q") {
                    a.push_str(" /qn /norestart");
                }
                ("msiexec.exe".to_string(), a)
            }
        }
    } else {
        let lower = args.to_lowercase();
        if exe_name.starts_with("unins") {
            // Inno Setup uninstaller.
            if !lower.contains("/verysilent") {
                args.push_str(" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART");
            }
        } else if !lower.contains("/s") && !lower.contains("/quiet") {
            // NSIS and many others; may still show UI for some apps.
            args.push_str(" /S");
        }
        (exe, args.trim().to_string())
    };

    let arg_list = if args.trim().is_empty() {
        String::new()
    } else {
        format!(" -ArgumentList {}", ps_quote(args.trim()))
    };
    format!(
        "$p = Start-Process -FilePath {}{arg_list} -Wait -PassThru -WindowStyle Hidden\n\
         exit $p.ExitCode",
        ps_quote(&file)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn msi_uses_product_code() {
        let s = uninstall_script("MsiExec.exe /I{12345678-ABCD-1234-ABCD-1234567890AB}");
        assert!(s.contains("'msiexec.exe'"));
        assert!(s.contains("/X {12345678-ABCD-1234-ABCD-1234567890AB} /qn /norestart"));
        assert!(s.contains("exit $p.ExitCode"));
    }

    #[test]
    fn inno_gets_verysilent_and_quotes_are_escaped() {
        let s = uninstall_script(r#""C:\Program Files\O'Brien App\unins000.exe""#);
        assert!(s.contains(r"'C:\Program Files\O''Brien App\unins000.exe'"));
        assert!(s.contains("/VERYSILENT"));
    }

    #[test]
    fn unquoted_path_with_spaces() {
        let (exe, args) = split_command(r"C:\Program Files\App\uninstall.exe /x y");
        assert_eq!(exe, r"C:\Program Files\App\uninstall.exe");
        assert_eq!(args, "/x y");
    }

    #[test]
    fn short_os_drops_vendor_and_build() {
        assert_eq!(
            short_os("Microsoft Windows 11 Pro 10.0.22631"),
            "Windows 11 Pro"
        );
        assert_eq!(short_os("Windows 10 Pro"), "Windows 10 Pro");
    }

    #[test]
    fn csv_quotes_when_needed() {
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("plain"), "plain");
    }
}
