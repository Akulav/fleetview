// Agents behind the master's web address: `wss://<public URL>/agent`.
//
// A minimal RFC 6455 WebSocket server (binary messages only) whose payload is
// the agent's ordinary pinned-TLS session. The TLS is terminated here, inside
// the master, with the master's own certificate, so the HTTPS proxy / CDN in
// front (AutoNode, Cloudflare) only ever carries ciphertext.

import crypto from "node:crypto";
import tls from "node:tls";
import { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const AGENT_WS_PATH = "/agent";
/** Largest WebSocket message accepted (inner TLS records are ≤ 16 KiB). */
const MAX_MESSAGE = 1 << 20;

/** Byte stream over one WebSocket connection (server side). */
export class WsDuplex extends Duplex {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.parts = [];
    this.partsLen = 0;
    this.closing = false;
    socket.on("data", (d) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      try {
        this.parse();
      } catch (e) {
        this.fail(1002, e.message);
      }
    });
    socket.on("end", () => this.push(null));
    socket.on("close", () => this.destroy());
    socket.on("error", (e) => this.destroy(e));
    // Keep idle connections open through proxies (Cloudflare drops at ~100 s).
    this.pinger = setInterval(() => this.frame(0x9, Buffer.alloc(0)), 30_000);
    this.pinger.unref();
    if (this.buf.length) queueMicrotask(() => this.parse());
  }

  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) throw new Error("message too large");
        len = Number(big);
        off = 10;
      }
      if (!masked) throw new Error("client frames must be masked");
      if (len > MAX_MESSAGE) throw new Error("message too large");
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);

      if (op === 0x8) return this.fail(1000, "");
      if (op === 0x9) {
        this.frame(0xa, data);
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.parts.push(data);
        this.partsLen += data.length;
        if (this.partsLen > MAX_MESSAGE) throw new Error("message too large");
        if (fin) {
          const msg = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
          this.parts = [];
          this.partsLen = 0;
          if (msg.length) this.push(msg);
        }
        continue;
      }
      throw new Error(`unknown opcode ${op}`);
    }
  }

  frame(op, data, cb) {
    if (this.socket.destroyed) return cb?.(new Error("closed"));
    const n = data.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (n >= 126) {
      head[0] = 0x80 | op;
      if (n < 65536) {
        head[1] = 126;
        head.writeUInt16BE(n, 2);
      } else {
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(n), 2);
      }
    }
    this.socket.write(Buffer.concat([head, data]), cb);
  }

  fail(code, reason) {
    if (!this.closing) {
      this.closing = true;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code);
      body.write(reason, 2);
      this.frame(0x8, body);
    }
    this.socket.end();
    this.push(null);
  }

  _read() {}
  _write(chunk, _enc, cb) {
    this.frame(0x2, chunk, cb);
  }
  _final(cb) {
    this.fail(1000, "");
    cb();
  }
  _destroy(err, cb) {
    clearInterval(this.pinger);
    this.socket.destroy();
    cb(err);
  }
}

/** Handle an HTTP upgrade to `/agent`; returns false when it isn't ours. */
export function handleAgentUpgrade(req, socket, head, { identity, hub, trustProxy, log }) {
  const path = new URL(req.url, "http://x").pathname.replace(/\/+$/, "");
  if (path !== AGENT_WS_PATH) return false;
  const key = req.headers["sec-websocket-key"];
  if (String(req.headers.upgrade).toLowerCase() !== "websocket" || !key || req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return true;
  }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay?.(true);
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  const peer = `${(trustProxy && fwd) || socket.remoteAddress || "?"}`.replace(/^::ffff:/, "") + " (web)";
  const ws = new WsDuplex(socket, head);
  const secured = new tls.TLSSocket(ws, {
    isServer: true,
    secureContext: tls.createSecureContext({ cert: identity.certPem, key: identity.keyPem, minVersion: "TLSv1.2" }),
  });
  secured.on("error", (e) => log(`agent ${peer}: ${e.message}`));
  hub.accept(secured, peer);
  return true;
}
