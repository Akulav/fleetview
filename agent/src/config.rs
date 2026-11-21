//! Agent configuration: how to find and trust the master.
//!
//! This file is written by the installer (values provided by the admin running
//! the master's "Generate agent installer config" action) and read by the
//! service at startup. It pins the master's identity so a rogue host on the LAN
//! cannot impersonate the master after an IP change.

use serde::{Deserialize, Serialize};

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Stable per-machine id. Generated on first run if absent.
    #[serde(default)]
    pub agent_id: String,

    /// Base64 Ed25519 public key of the master — used to verify discovery beacons.
    pub master_public_key: String,

    /// SHA-256 hex fingerprint of the master's TLS certificate (pinned).
    pub master_cert_fingerprint: String,

    /// Shared enrollment secret proving this agent is authorised.
    pub enrollment_secret: String,

    /// Optional fixed master address `host:port`. When set, discovery is skipped
    /// and we connect here directly (useful across subnets / static master).
    #[serde(default)]
    pub master_address: Option<String>,

    /// Extra subnet broadcast addresses to probe (e.g. "192.168.10.255:48621")
    /// for multi-subnet LANs where the default broadcast won't reach the master.
    #[serde(default)]
    pub discovery_targets: Vec<String>,

    /// Seconds between telemetry reports.
    #[serde(default = "default_telemetry_interval")]
    pub telemetry_interval_secs: u64,

    /// Base URL of the e-Management ANSC server, e.g. `https://docs.ansc.md`.
    /// When set, the user-session helper runs the MoldSign document-signing
    /// bridge, trusting only this origin and validating signing tokens against
    /// this (pinned) server — never a URL taken from a request. Left unset, the
    /// bridge is disabled and the agent behaves exactly as before.
    #[serde(default)]
    pub emanagement_url: Option<String>,

    /// Optional override for MoldSign's `SignDesktop.exe` (auto-located under
    /// `Program Files (x86)\STISC\MoldSign` when absent).
    #[serde(default)]
    pub moldsign_path: Option<String>,

    /// Optional fixed shared secret presented by the bridge to e-Management on
    /// the token-validation callback. When unset, the service generates a fresh
    /// per-run token. Pin it (and the matching value on the e-Management server)
    /// only if you want end-to-end enforcement of that extra layer.
    #[serde(default)]
    pub sign_bridge_token: Option<String>,

    /// Per-agent secret, kept in its own file (`agent.key`), never in the
    /// config the master generates. Filled in by [`AgentConfig::load`].
    #[serde(skip)]
    pub agent_key: String,
}

fn default_telemetry_interval() -> u64 {
    30
}

/// Settings the service derives from [`AgentConfig`] and hands to the helper so
/// it can run the MoldSign sign-bridge. All strings are already validated.
#[derive(Debug, Clone)]
pub struct SignBridgeSettings {
    pub origin: String,
    pub validate_url: String,
    pub token: String,
    pub moldsign_path: Option<String>,
}

impl AgentConfig {
    /// Build the sign-bridge settings from the pinned e-Management URL, or
    /// `None` when signing isn't configured or the URL is unusable. `token` is
    /// the per-run secret the service generated for this boot.
    pub fn sign_bridge_settings(&self, token: String) -> Option<SignBridgeSettings> {
        let base = self.emanagement_url.as_deref()?.trim();
        if base.is_empty() {
            return None;
        }
        let url = match reqwest::Url::parse(base) {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!(
                    "emanagement_url `{base}` is not a valid URL ({e}); bridge disabled"
                );
                return None;
            }
        };
        if !matches!(url.scheme(), "http" | "https") {
            tracing::warn!("emanagement_url `{base}` must be http/https; bridge disabled");
            return None;
        }
        let origin = url.origin().ascii_serialization();
        if origin == "null" {
            tracing::warn!("emanagement_url `{base}` has no usable origin; bridge disabled");
            return None;
        }
        let validate_url = match url.join("/api/sign/validate") {
            Ok(u) => u.to_string(),
            Err(e) => {
                tracing::warn!("cannot build validate URL from `{base}` ({e}); bridge disabled");
                return None;
            }
        };
        let token = self
            .sign_bridge_token
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .unwrap_or(token);
        Some(SignBridgeSettings {
            origin,
            validate_url,
            token,
            moldsign_path: self.moldsign_path.clone(),
        })
    }
}

impl AgentConfig {
    pub fn load() -> anyhow::Result<Self> {
        let path = paths::config_path();
        let text = std::fs::read_to_string(&path)
            .map_err(|e| anyhow::anyhow!("cannot read {}: {e}", path.display()))?;
        let mut cfg: AgentConfig = serde_json::from_str(&text)?;
        if cfg.agent_id.trim().is_empty() {
            // The installer overwrites agent.config.json on every (re)install
            // with an empty agent_id. Keep the id in its own file so an upgrade
            // doesn't make the PC show up as a brand-new agent on the master.
            cfg.agent_id = load_or_create_agent_id();
        }
        cfg.agent_key = load_or_create_secret(&paths::agent_key_path(), 32);
        Ok(cfg)
    }
}

/// Config keys the master may change remotely (via `MasterMsg::SetConfig`).
/// Trust material — `master_public_key`, `master_cert_fingerprint`,
/// `enrollment_secret`, `agent_id` — is deliberately absent: it can only come
/// from a master-generated config, never from a live message.
pub const REMOTE_SETTABLE_KEYS: &[&str] = &[
    "emanagement_url",
    "moldsign_path",
    "telemetry_interval_secs",
    "master_address",
    "discovery_targets",
];

/// Apply remote config changes to `agent.config.json`. Returns the keys
/// actually changed (empty = nothing to do). Unknown or forbidden keys are an
/// error, so a typo can't silently do nothing. The merged document must still
/// be a valid [`AgentConfig`] before it is written.
pub fn apply_remote_config(updates: &[(String, Option<String>)]) -> anyhow::Result<Vec<String>> {
    use anyhow::{bail, Context};
    use serde_json::{Map, Value};

    let path = paths::config_path();
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let mut doc: Map<String, Value> = serde_json::from_str(&text)
        .with_context(|| format!("{} is not valid JSON", path.display()))?;

    let mut changed = Vec::new();
    for (key, value) in updates {
        let key = key.trim();
        if !REMOTE_SETTABLE_KEYS.contains(&key) {
            bail!("`{key}` cannot be set remotely");
        }
        let new_value = parse_config_value(key, value.as_deref())?;
        if doc.get(key) != Some(&new_value) {
            doc.insert(key.to_string(), new_value);
            changed.push(key.to_string());
        }
    }
    if changed.is_empty() {
        return Ok(changed);
    }

    // Reject a change that would make the config unloadable, before writing.
    serde_json::from_value::<AgentConfig>(Value::Object(doc.clone()))
        .context("the resulting config would be invalid")?;

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc)?)?;
    std::fs::rename(&tmp, &path).context("replace config")?;
    Ok(changed)
}

/// Turn a remote string into the JSON value a key expects. An empty value
/// clears the key (JSON null), which for optional keys restores the default.
fn parse_config_value(key: &str, value: Option<&str>) -> anyhow::Result<serde_json::Value> {
    use serde_json::Value;
    let v = value.map(str::trim).filter(|s| !s.is_empty());
    Ok(match (key, v) {
        (_, None) => Value::Null,
        ("telemetry_interval_secs", Some(s)) => Value::from(
            s.parse::<u64>()
                .map_err(|_| anyhow::anyhow!("telemetry_interval_secs must be a whole number"))?,
        ),
        ("discovery_targets", Some(s)) => Value::Array(
            s.split([',', ';', '\n'])
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(|t| Value::String(t.to_string()))
                .collect(),
        ),
        (_, Some(s)) => Value::String(s.to_string()),
    })
}

fn load_or_create_agent_id() -> String {
    load_or_create_secret(&paths::agent_id_path(), 16)
}

/// Read a hex value from `path`, or create a random one of `bytes` bytes.
/// Both the agent id and the agent key survive reinstalls and upgrades.
fn load_or_create_secret(path: &std::path::Path, bytes: usize) -> String {
    if let Ok(v) = std::fs::read_to_string(path) {
        let v = v.trim();
        if !v.is_empty() && v.chars().all(|c| c.is_ascii_hexdigit()) {
            return v.to_string();
        }
    }
    use rand::RngCore;
    let mut b = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut b);
    let v = hex::encode(b);
    if let Err(e) = paths::ensure_data_dir().and_then(|_| std::fs::write(path, &v)) {
        tracing::warn!("cannot persist {}: {e}", path.display());
    }
    v
}
