// LAN discovery (UDP 48621). Agents broadcast a DiscoveryQuery; the master
// answers with a DiscoveryBeacon signed by its Ed25519 identity, and also
// broadcasts one every 15 s. Format: "FLEETVIEW/1" + 0x00 + MessagePack.
// Only useful when the master shares a LAN (or a routed subnet) with the
// agents; a master on the internet is reached via FLEETVIEW_AGENT_ADDRESS.

import dgram from "node:dgram";
import * as mp from "./msgpack.js";
import { PROTOCOL_VERSION } from "./agents.js";

const MAGIC = Buffer.from("FLEETVIEW/1");

export function signingBytes(protocol, controlPort, fingerprint, masterName, issuedAtMs) {
  return Buffer.from(`${protocol}|${controlPort}|${fingerprint}|${masterName}|${issuedAtMs}`);
}

export function buildBeacon(identity, controlPort) {
  const issued = Date.now();
  return {
    protocol: PROTOCOL_VERSION,
    control_port: controlPort,
    cert_fingerprint: identity.fingerprint,
    master_name: identity.masterName,
    issued_at_ms: issued,
    signature: identity.sign(signingBytes(PROTOCOL_VERSION, controlPort, identity.fingerprint, identity.masterName, issued)),
  };
}

export function datagram(body) {
  return Buffer.concat([MAGIC, Buffer.from([0]), mp.encode(body)]);
}

export function parseDatagram(buf) {
  if (buf.length <= MAGIC.length + 1 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  try {
    return mp.decode(buf.subarray(MAGIC.length + 1));
  } catch {
    return null;
  }
}

export function startDiscovery({ config, identity, log }) {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const beacon = () => datagram(buildBeacon(identity, config.agentPort));
  sock.on("error", (e) => log(`discovery: ${e.message}`));
  sock.on("message", (buf, rinfo) => {
    const q = parseDatagram(buf);
    // Answer genuine queries only (our own beacons come back too).
    if (!q || q.protocol !== PROTOCOL_VERSION || typeof q.hostname !== "string" || "signature" in q) return;
    sock.send(beacon(), rinfo.port, rinfo.address);
  });
  sock.bind(config.discoveryPort, () => {
    sock.setBroadcast(true);
    log(`LAN discovery on udp/${config.discoveryPort}`);
  });
  const timer = setInterval(() => {
    sock.send(beacon(), config.discoveryPort, "255.255.255.255", () => {});
  }, 15_000);
  timer.unref();
  return {
    close() {
      clearInterval(timer);
      sock.close();
    },
  };
}
