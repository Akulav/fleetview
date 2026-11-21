//! Wire protocol between agent and master.
//!
//! Frames are length-delimited MessagePack values (see `tokio_util`'s
//! `LengthDelimitedCodec` on the transport side). Every frame is one
//! [`Envelope`]. File transfers are chunked so large installers don't have to
//! be buffered whole.

use serde::{Deserialize, Serialize};

/// Telemetry snapshot an agent reports on a schedule and on demand.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Telemetry {
    pub hostname: String,
    pub os_version: String,
    pub logged_in_user: Option<String>,
    pub uptime_secs: u64,
    pub cpu_usage_pct: f32,
    pub cpu_name: String,
    pub cpu_cores: usize,
    pub mem_total_mb: u64,
    pub mem_used_mb: u64,
    pub disks: Vec<DiskInfo>,
    pub ip_addresses: Vec<String>,
    pub mac_addresses: Vec<String>,
    pub agent_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    pub mount: String,
    pub total_gb: f64,
    pub available_gb: f64,
}

/// One installed-software entry (from the uninstall registry keys).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoftwareEntry {
    pub name: String,
    pub version: Option<String>,
    pub publisher: Option<String>,
    pub uninstall_string: Option<String>,
}

/// Result of a command the master asked the agent to run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub command_id: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// How an agent identifies itself after the TLS handshake. The master checks
/// `enrollment_secret` before accepting any further messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    pub agent_id: String,
    pub hostname: String,
    pub agent_version: String,
    pub enrollment_secret: String,
    /// Per-agent secret generated on the PC (never leaves it except here).
    /// The master pins its hash to `agent_id` the first time it sees it and
    /// from then on refuses that id without the same key, so holding the
    /// shared enrollment secret is not enough to impersonate an enrolled PC.
    /// Empty from agents older than 0.5.0.
    #[serde(default)]
    pub agent_key: String,
}

/// Messages the master sends to an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MasterMsg {
    /// Accept/deny after receiving [`Hello`].
    HelloAck {
        accepted: bool,
        reason: String,
    },
    /// Ask for a fresh telemetry snapshot now.
    RequestTelemetry,
    /// Ask for the installed-software inventory.
    RequestSoftware,
    /// Run a PowerShell script (as LocalSystem). `elevated` is advisory; the
    /// service already runs elevated.
    RunPowerShell {
        command_id: String,
        script: String,
    },
    /// Begin a file push (installer, script, ...). Followed by `FileChunk`s and
    /// a `FileEnd`.
    FileBegin {
        transfer_id: String,
        file_name: String,
        total_len: u64,
        /// When set, run this on the saved file once the transfer completes.
        run_after: Option<RunSpec>,
    },
    FileChunk {
        transfer_id: String,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
    FileEnd {
        transfer_id: String,
    },
    /// Ask the agent to download an installer from a URL and run it silently.
    InstallFromUrl {
        command_id: String,
        url: String,
        run: RunSpec,
    },
    /// One-off screenshot of the active session's primary display.
    RequestScreenshot {
        command_id: String,
    },
    /// Start/stop a periodic screenshot stream (live view).
    StartScreenStream {
        interval_ms: u64,
        jpeg_quality: u8,
    },
    StopScreenStream,
    /// Show a toast/notification to the logged-in user (transparency feature).
    NotifyUser {
        title: String,
        body: String,
    },
    /// Change a few non-security keys in the agent's config and apply them
    /// (restarting the service when needed). The agent only honours the keys
    /// in its own allow-list; trust material (master key, cert fingerprint,
    /// enrollment secret, agent_id) is ignored. `None` clears a key.
    SetConfig {
        command_id: String,
        updates: Vec<ConfigUpdate>,
    },
    /// Request the agent to re-run discovery (e.g. master moved).
    Ping,
}

/// One remote config change: set `key` to `value`, or clear it when `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigUpdate {
    pub key: String,
    pub value: Option<String>,
}

/// How to execute a pushed/downloaded file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSpec {
    pub command_id: String,
    /// Arguments passed to the executable (e.g. `/S`, `/qn`). Split already.
    pub args: Vec<String>,
    /// If true, the path is passed to `msiexec /i` instead of run directly.
    pub is_msi: bool,
}

/// Messages an agent sends to the master.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentMsg {
    Hello(Hello),
    Telemetry(Telemetry),
    Software(Vec<SoftwareEntry>),
    CommandResult(CommandResult),
    /// A full screenshot frame (JPEG/PNG bytes).
    ScreenFrame {
        command_id: Option<String>,
        width: u32,
        height: u32,
        #[serde(with = "serde_bytes")]
        jpeg: Vec<u8>,
    },
    /// Progress/acknowledgement of a file transfer.
    FileAck {
        transfer_id: String,
        received: u64,
    },
    /// Keep-alive.
    Heartbeat,
    /// Free-form log line surfaced in the master's event view.
    Log {
        level: String,
        message: String,
    },
}
