// The agent channel: a TLS server speaking the FleetView wire protocol
// (length-delimited MessagePack frames, see shared/src/protocol.rs), plus the
// registry of every agent ever seen.
//
// Frame = u32 big-endian length + MessagePack body. The first agent frame must
// be `{"Hello": {...}}` with the enrollment secret; the master answers
// `{"HelloAck": {accepted, reason}}`. Afterwards agents send Telemetry,
// Software, CommandResult, FileAck, ScreenFrame, Heartbeat and Log.

import tls from "node:tls";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import * as mp from "./msgpack.js";
import { JsonFile } from "./store.js";
import { secretsMatch, agentKeyHash } from "./identity.js";

export const PROTOCOL_VERSION = 1;
const MAX_FRAME = 64 * 1024 * 1024;
const PRE_AUTH_MAX_FRAME = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 20_000;
/** Agents heartbeat every 20 s; silence for this long means the PC is gone. */
const IDLE_TIMEOUT_MS = 90_000;

/** One live TLS connection to an agent. */
class Connection {
  constructor(socket, peer) {
    this.socket = socket;
    this.peer = peer;
    this.closed = false;
  }
  /** Queue a MasterMsg. Returns false when the connection is gone. */
  send(msg) {
    if (this.closed) return false;
    const body = mp.encode(msg);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([head, body]));
    return true;
  }
  /** Send and wait until the socket buffer drains (backpressure for file
   * streaming, so a big installer is never buffered whole in memory). */
  async sendDrained(msg) {
    if (!this.send(msg)) throw new Error("connection closed");
    if (this.socket.writableNeedDrain) {
      await new Promise((resolve, reject) => {
        const done = (err) => {
          this.socket.off("drain", ok);
          this.socket.off("close", closed);
          err ? reject(err) : resolve();
        };
        const ok = () => done();
        const closed = () => done(new Error("connection closed"));
        this.socket.once("drain", ok);
        this.socket.once("close", closed);
      });
    }
  }
  close() {
    this.closed = true;
    this.socket.destroy();
  }
}

export class AgentHub extends EventEmitter {
  constructor({ config, identity, log }) {
    super();
    this.setMaxListeners(0);
    this.config = config;
    this.identity = identity;
    this.log = log;
    this.file = new JsonFile(join(config.dataDir, "agents.json"), [], { private: true });
    /** id → agent record (persisted fields + live state). */
    this.agents = new Map();
    for (const a of this.file.value) {
      this.agents.set(a.agent_id, { ...a, online: false, conn: null, telemetry: a.telemetry ?? null, software: a.software ?? [] });
    }
    this.server = null;
  }

  // ---- registry --------------------------------------------------------

  list() {
    return [...this.agents.values()];
  }
  get(id) {
    return this.agents.get(id);
  }
  isOnline(id) {
    return !!this.agents.get(id)?.conn;
  }
  /** Send a MasterMsg to an online agent. */
  send(id, msg) {
    const a = this.agents.get(id);
    return a?.conn ? a.conn.send(msg) : false;
  }
  conn(id) {
    return this.agents.get(id)?.conn ?? null;
  }
  save() {
    this.file.value = this.list().map((a) => ({
      agent_id: a.agent_id,
      hostname: a.hostname,
      first_seen: a.first_seen,
      last_seen: a.last_seen,
      agent_version: a.agent_version ?? "",
      tags: a.tags ?? [],
      notes: a.notes ?? "",
      ips: a.ips ?? [],
      macs: a.macs ?? [],
      os: a.os ?? "",
      user: a.user ?? null,
      key_hash: a.key_hash ?? null,
      telemetry: a.telemetry ?? null,
      software: a.software ?? [],
    }));
    this.file.touch();
  }
  remove(id) {
    const a = this.agents.get(id);
    if (!a || a.conn) return false;
    this.agents.delete(id);
    this.save();
    this.emit("agents");
    return true;
  }
  changed(a) {
    this.emit("agent", a);
  }

  // ---- TLS server ------------------------------------------------------

  listen() {
    return new Promise((resolve, reject) => {
      this.server = tls.createServer(
        {
          cert: this.identity.certPem,
          key: this.identity.keyPem,
          minVersion: "TLSv1.2",
          handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        },
        (socket) => this.accept(socket),
      );
      this.server.on("tlsClientError", (err, socket) => {
        this.log(`TLS handshake from ${socket?.remoteAddress ?? "?"} failed: ${err.message}`);
      });
      this.server.once("error", reject);
      this.server.listen(this.config.agentPort, this.config.agentHost, () => {
        this.server.off("error", reject);
        this.log(`agent channel listening on ${this.config.agentHost}:${this.server.address().port} (TLS)`);
        resolve();
      });
    });
  }

  close() {
    for (const a of this.agents.values()) a.conn?.close();
    this.server?.close();
    this.file.flush();
  }

  accept(socket) {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`.replace(/^::ffff:/, "");
    const conn = new Connection(socket, peer);
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let maxFrame = PRE_AUTH_MAX_FRAME;
    let agentId = null;
    let hello = null;

    const hsTimer = setTimeout(() => {
      this.log(`${peer}: no Hello within ${HANDSHAKE_TIMEOUT_MS / 1000} s`);
      conn.close();
    }, HANDSHAKE_TIMEOUT_MS);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => {
      this.log(`${hello?.hostname ?? peer}: no traffic for ${IDLE_TIMEOUT_MS / 1000} s, disconnecting`);
      conn.close();
    });

    const onFrame = (frame) => {
      const msg = mp.decode(frame);
      if (!agentId) {
        clearTimeout(hsTimer);
        hello = this.authenticate(conn, msg);
        if (!hello) return conn.close();
        agentId = hello.id;
        maxFrame = MAX_FRAME;
        return;
      }
      this.onAgentMsg(agentId, msg);
    };

    socket.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        while (buf.length >= 4) {
          const n = buf.readUInt32BE(0);
          if (n > maxFrame) throw new Error(`frame of ${n} bytes exceeds the limit`);
          if (buf.length < 4 + n) break;
          const frame = buf.subarray(4, 4 + n);
          buf = buf.subarray(4 + n);
          onFrame(frame);
          if (conn.closed) return;
        }
      } catch (e) {
        this.log(`${hello?.hostname ?? peer}: protocol error: ${e.message}`);
        conn.close();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(hsTimer);
      conn.closed = true;
      if (!agentId) return;
      const a = this.agents.get(agentId);
      // Only if this is still the current connection: an agent that
      // reconnected before its old connection timed out stays online.
      if (a && a.conn === conn) {
        a.conn = null;
        a.online = false;
        a.last_seen = new Date().toISOString();
        this.save();
        this.log(`${a.hostname} went offline`);
        this.changed(a);
        this.emit("offline", agentId);
      }
    });
  }

  /** Check a Hello and register the agent. Returns {id, hostname} or null. */
  authenticate(conn, msg) {
    const reject = (reason) => {
      conn.send({ HelloAck: { accepted: false, reason } });
      // Let the ack reach the agent before closing.
      conn.socket.end();
      return null;
    };
    let kind, h;
    try {
      [kind, h] = mp.variant(msg);
    } catch {
      return reject("expected hello");
    }
    if (kind !== "Hello" || !h) return reject("expected hello");
    if (h.protocol !== PROTOCOL_VERSION) return reject("protocol version mismatch");
    if (!secretsMatch(h.enrollment_secret ?? "", this.identity.enrollmentSecret)) {
      this.log(`${conn.peer}: enrollment secret rejected (${h.hostname})`);
      return reject("enrollment secret rejected");
    }
    const id = String(h.agent_id ?? "").trim() || `host:${h.hostname}`;
    const key = String(h.agent_key ?? "").trim();
    const existing = this.agents.get(id);
    // The shared secret proves the PC belongs to this fleet; its own key
    // proves it is the PC that first enrolled under this id.
    if (existing?.key_hash && !secretsMatch(agentKeyHash(key), existing.key_hash)) {
      this.log(`refused ${h.hostname} (${id}) from ${conn.peer}: agent key does not match`);
      return reject("this PC id belongs to another agent");
    }
    conn.send({ HelloAck: { accepted: true, reason: "" } });

    const now = new Date().toISOString();
    const a =
      existing ??
      { agent_id: id, first_seen: now, tags: [], notes: "", software: [], telemetry: null, key_hash: null };
    if (!a.key_hash && key) a.key_hash = agentKeyHash(key);
    const previous = a.agent_version;
    a.agent_version = h.agent_version ?? "";
    a.hostname = h.hostname ?? a.hostname ?? id;
    a.last_seen = now;
    a.addr = conn.peer;
    a.online = true;
    a.conn?.close(); // a stale connection from the same PC
    a.conn = conn;
    this.agents.set(id, a);
    this.save();
    this.log(`${a.hostname} connected from ${conn.peer} (agent ${a.agent_version})`);
    if (previous && previous !== a.agent_version) this.log(`${a.hostname}: agent ${previous} → ${a.agent_version}`);
    this.changed(a);
    this.emit("online", id);
    conn.send("RequestTelemetry");
    conn.send("RequestSoftware");
    return { id, hostname: a.hostname };
  }

  onAgentMsg(id, msg) {
    const a = this.agents.get(id);
    if (!a) return;
    a.last_seen = new Date().toISOString();
    const [kind, body] = mp.variant(msg);
    switch (kind) {
      case "Heartbeat":
        return;
      case "Telemetry": {
        a.telemetry = normalizeTelemetry(body);
        a.os = a.telemetry.os_version;
        a.user = a.telemetry.logged_in_user;
        a.ips = a.telemetry.ip_addresses;
        a.macs = a.telemetry.mac_addresses;
        if (a.telemetry.agent_version) a.agent_version = a.telemetry.agent_version;
        this.save();
        return this.changed(a);
      }
      case "Software": {
        a.software = (body ?? []).map((s) => ({
          name: s.name,
          version: s.version ?? null,
          publisher: s.publisher ?? null,
          uninstall_string: s.uninstall_string ?? null,
        }));
        a.software_at = new Date().toISOString();
        this.save();
        this.emit("software", id);
        return this.changed(a);
      }
      case "CommandResult":
        return this.emit("result", id, {
          command_id: body.command_id,
          success: !!body.success,
          exit_code: body.exit_code ?? null,
          stdout: body.stdout ?? "",
          stderr: body.stderr ?? "",
        });
      case "FileAck":
        return this.emit("ack", id, body.transfer_id, Number(body.received));
      case "ScreenFrame":
        return this.emit("screen", id, {
          command_id: body.command_id ?? null,
          width: body.width,
          height: body.height,
          jpeg: Buffer.from(body.jpeg),
          at: new Date().toISOString(),
        });
      case "Log":
        return this.log(`${a.hostname} [${body.level}]: ${body.message}`);
      default:
        return this.log(`${a.hostname}: ignoring unknown message ${kind}`);
    }
  }
}

function normalizeTelemetry(t) {
  return {
    hostname: t.hostname,
    os_version: t.os_version,
    logged_in_user: t.logged_in_user ?? null,
    uptime_secs: Number(t.uptime_secs),
    cpu_usage_pct: Number(t.cpu_usage_pct),
    cpu_name: t.cpu_name,
    cpu_cores: Number(t.cpu_cores),
    mem_total_mb: Number(t.mem_total_mb),
    mem_used_mb: Number(t.mem_used_mb),
    disks: (t.disks ?? []).map((d) => ({ mount: d.mount, total_gb: d.total_gb, available_gb: d.available_gb })),
    ip_addresses: t.ip_addresses ?? [],
    mac_addresses: t.mac_addresses ?? [],
    agent_version: t.agent_version ?? "",
    at: new Date().toISOString(),
  };
}
