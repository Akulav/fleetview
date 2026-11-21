//! Identity, signing and enrollment-token helpers.
//!
//! The master owns a long-lived Ed25519 identity keypair. Its public key and
//! the SHA-256 fingerprint of its TLS certificate are baked into the agent
//! configuration at install time. That lets an agent verify that a discovery
//! beacon (and the TLS endpoint it points at) really belongs to *its* master,
//! even after the master's IP address changes.

use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The master's secret identity. Persisted to disk (user-only ACL) by the master.
#[derive(Clone, Serialize, Deserialize)]
pub struct MasterIdentity {
    /// Base64-encoded 32-byte Ed25519 signing (secret) key.
    pub signing_key_b64: String,
}

impl MasterIdentity {
    pub fn generate() -> Self {
        let sk = SigningKey::generate(&mut OsRng);
        Self {
            signing_key_b64: B64.encode(sk.to_bytes()),
        }
    }

    pub fn signing_key(&self) -> anyhow::Result<SigningKey> {
        let bytes = B64.decode(self.signing_key_b64.trim())?;
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid signing key length"))?;
        Ok(SigningKey::from_bytes(&arr))
    }

    /// Base64 public key, to ship to agents.
    pub fn public_key_b64(&self) -> anyhow::Result<String> {
        Ok(B64.encode(self.signing_key()?.verifying_key().to_bytes()))
    }

    pub fn sign(&self, msg: &[u8]) -> anyhow::Result<String> {
        let sig = self.signing_key()?.sign(msg);
        Ok(B64.encode(sig.to_bytes()))
    }
}

/// Verify a base64 signature against a base64 Ed25519 public key.
pub fn verify_signature(public_key_b64: &str, msg: &[u8], signature_b64: &str) -> bool {
    let Ok(pk_bytes) = B64.decode(public_key_b64.trim()) else {
        return false;
    };
    let Ok(pk_arr): Result<[u8; 32], _> = pk_bytes.as_slice().try_into() else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk_arr) else {
        return false;
    };
    let Ok(sig_bytes) = B64.decode(signature_b64.trim()) else {
        return false;
    };
    let Ok(sig_arr): Result<[u8; 64], _> = sig_bytes.as_slice().try_into() else {
        return false;
    };
    let sig = Signature::from_bytes(&sig_arr);
    vk.verify(msg, &sig).is_ok()
}

/// SHA-256 fingerprint of a DER certificate, formatted as lowercase hex.
pub fn cert_fingerprint(der: &[u8]) -> String {
    let digest = Sha256::digest(der);
    hex::encode(digest)
}

/// SHA-256 of a per-agent key as lowercase hex — what the master stores, so a
/// leaked `known_agents.json` doesn't hand out the keys themselves.
pub fn agent_key_hash(key: &str) -> String {
    hex::encode(Sha256::digest(key.trim().as_bytes()))
}

/// Constant-time-ish comparison of two enrollment secrets.
pub fn secrets_match(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Generate a random URL-safe enrollment secret.
pub fn random_secret() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 24];
    OsRng.fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}
