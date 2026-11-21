use fleetview_shared::crypto::{cert_fingerprint, secrets_match, MasterIdentity};
use fleetview_shared::discovery::DiscoveryBeacon;
use fleetview_shared::protocol::{AgentMsg, MasterMsg};
use fleetview_shared::PROTOCOL_VERSION;

#[test]
fn identity_sign_and_verify() {
    let id = MasterIdentity::generate();
    let pk = id.public_key_b64().unwrap();
    let msg = b"hello fleet";
    let sig = id.sign(msg).unwrap();
    assert!(fleetview_shared::crypto::verify_signature(&pk, msg, &sig));
    assert!(!fleetview_shared::crypto::verify_signature(
        &pk,
        b"tampered",
        &sig
    ));
}

#[test]
fn beacon_signature_roundtrip() {
    let id = MasterIdentity::generate();
    let bytes = DiscoveryBeacon::signing_bytes(PROTOCOL_VERSION, 48620, "abcd", "Master", 123);
    let sig = id.sign(&bytes).unwrap();
    let beacon = DiscoveryBeacon {
        protocol: PROTOCOL_VERSION,
        control_port: 48620,
        cert_fingerprint: "abcd".into(),
        master_name: "Master".into(),
        issued_at_ms: 123,
        signature: sig,
    };
    let pk = id.public_key_b64().unwrap();
    assert!(fleetview_shared::crypto::verify_signature(
        &pk,
        &beacon.canonical_bytes(),
        &beacon.signature
    ));
}

#[test]
fn fingerprint_is_stable_hex() {
    let fp = cert_fingerprint(b"some-der-bytes");
    assert_eq!(fp.len(), 64);
    assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(secrets_match(&fp, &cert_fingerprint(b"some-der-bytes")));
}

#[test]
fn hello_without_agent_key_still_parses() {
    // What an agent older than 0.5.0 sends: no `agent_key` field.
    #[derive(serde::Serialize)]
    struct OldHello {
        protocol: u32,
        agent_id: String,
        hostname: String,
        agent_version: String,
        enrollment_secret: String,
    }
    #[derive(serde::Serialize)]
    enum OldAgentMsg {
        Hello(OldHello),
    }
    let old = OldAgentMsg::Hello(OldHello {
        protocol: PROTOCOL_VERSION,
        agent_id: "ab12".into(),
        hostname: "PC".into(),
        agent_version: "0.4.1".into(),
        enrollment_secret: "s".into(),
    });
    let bytes = rmp_serde::to_vec_named(&old).unwrap();
    match rmp_serde::from_slice::<AgentMsg>(&bytes).unwrap() {
        AgentMsg::Hello(h) => {
            assert_eq!(h.agent_id, "ab12");
            assert!(h.agent_key.is_empty());
        }
        _ => panic!("wrong variant"),
    }
}

#[test]
fn agent_key_hash_is_stable() {
    let h = fleetview_shared::crypto::agent_key_hash("k1");
    assert_eq!(h.len(), 64);
    assert_eq!(h, fleetview_shared::crypto::agent_key_hash(" k1 "));
    assert_ne!(h, fleetview_shared::crypto::agent_key_hash("k2"));
}

#[test]
fn protocol_messagepack_roundtrip() {
    let msg = MasterMsg::FileChunk {
        transfer_id: "t1".into(),
        data: vec![0u8, 1, 2, 3, 255],
    };
    let bytes = rmp_serde::to_vec_named(&msg).unwrap();
    let back: MasterMsg = rmp_serde::from_slice(&bytes).unwrap();
    match back {
        MasterMsg::FileChunk { transfer_id, data } => {
            assert_eq!(transfer_id, "t1");
            assert_eq!(data, vec![0u8, 1, 2, 3, 255]);
        }
        _ => panic!("wrong variant"),
    }

    let frame = AgentMsg::ScreenFrame {
        command_id: Some("c".into()),
        width: 4,
        height: 2,
        jpeg: vec![9, 8, 7],
    };
    let bytes = rmp_serde::to_vec_named(&frame).unwrap();
    let _back: AgentMsg = rmp_serde::from_slice(&bytes).unwrap();
}
