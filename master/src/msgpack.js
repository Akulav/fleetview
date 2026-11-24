// Minimal MessagePack codec matching what the Rust side (rmp-serde,
// `to_vec_named`) produces and accepts:
//
//   * structs          → maps keyed by field name
//   * unit enum variant → the variant name as a string        ("Heartbeat")
//   * other variants   → a one-entry map { Variant: content }  ({"Hello": {...}})
//   * Option::None     → nil
//   * serde_bytes      → bin
//
// JS mapping: Buffer/Uint8Array ⇄ bin, string ⇄ str, number/bigint ⇄ int or
// float, null/undefined → nil, Array ⇄ array, plain object ⇄ map.
// Use `float32(x)` / `float64(x)` to force a float encoding for whole numbers.

export class Float {
  constructor(value, bits = 64) {
    this.value = value;
    this.bits = bits;
  }
}
export const float64 = (v) => new Float(v, 64);

export function encode(value) {
  const parts = [];
  write(value, parts);
  return Buffer.concat(parts);
}

function u8(n) {
  return Buffer.from([n]);
}

function write(v, out) {
  if (v === null || v === undefined) return out.push(u8(0xc0));
  if (v === true) return out.push(u8(0xc3));
  if (v === false) return out.push(u8(0xc2));
  if (v instanceof Float) {
    const b = Buffer.alloc(v.bits === 32 ? 5 : 9);
    if (v.bits === 32) {
      b[0] = 0xca;
      b.writeFloatBE(v.value, 1);
    } else {
      b[0] = 0xcb;
      b.writeDoubleBE(v.value, 1);
    }
    return out.push(b);
  }
  if (typeof v === "number") {
    if (Number.isInteger(v)) return writeInt(BigInt(v), out);
    const b = Buffer.alloc(9);
    b[0] = 0xcb;
    b.writeDoubleBE(v, 1);
    return out.push(b);
  }
  if (typeof v === "bigint") return writeInt(v, out);
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    const n = s.length;
    if (n < 32) out.push(u8(0xa0 | n));
    else if (n < 0x100) out.push(Buffer.from([0xd9, n]));
    else if (n < 0x10000) out.push(header(0xda, n, 2));
    else out.push(header(0xdb, n, 4));
    return out.push(s);
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const n = v.length;
    if (n < 0x100) out.push(Buffer.from([0xc4, n]));
    else if (n < 0x10000) out.push(header(0xc5, n, 2));
    else out.push(header(0xc6, n, 4));
    return out.push(Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.length));
  }
  if (Array.isArray(v)) {
    const n = v.length;
    if (n < 16) out.push(u8(0x90 | n));
    else if (n < 0x10000) out.push(header(0xdc, n, 2));
    else out.push(header(0xdd, n, 4));
    for (const x of v) write(x, out);
    return;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    const n = keys.length;
    if (n < 16) out.push(u8(0x80 | n));
    else if (n < 0x10000) out.push(header(0xde, n, 2));
    else out.push(header(0xdf, n, 4));
    for (const k of keys) {
      write(k, out);
      write(v[k], out);
    }
    return;
  }
  throw new TypeError(`cannot encode ${typeof v}`);
}

function header(tag, n, bytes) {
  const b = Buffer.alloc(1 + bytes);
  b[0] = tag;
  if (bytes === 2) b.writeUInt16BE(n, 1);
  else b.writeUInt32BE(n, 1);
  return b;
}

function writeInt(n, out) {
  if (n >= 0n) {
    if (n < 128n) return out.push(u8(Number(n)));
    if (n < 0x100n) return out.push(Buffer.from([0xcc, Number(n)]));
    if (n < 0x10000n) return out.push(header(0xcd, Number(n), 2));
    if (n < 0x100000000n) return out.push(header(0xce, Number(n), 4));
    const b = Buffer.alloc(9);
    b[0] = 0xcf;
    b.writeBigUInt64BE(n, 1);
    return out.push(b);
  }
  if (n >= -32n) return out.push(u8(Number(n) & 0xff));
  if (n >= -128n) {
    const b = Buffer.alloc(2);
    b[0] = 0xd0;
    b.writeInt8(Number(n), 1);
    return out.push(b);
  }
  if (n >= -32768n) {
    const b = Buffer.alloc(3);
    b[0] = 0xd1;
    b.writeInt16BE(Number(n), 1);
    return out.push(b);
  }
  if (n >= -2147483648n) {
    const b = Buffer.alloc(5);
    b[0] = 0xd2;
    b.writeInt32BE(Number(n), 1);
    return out.push(b);
  }
  const b = Buffer.alloc(9);
  b[0] = 0xd3;
  b.writeBigInt64BE(n, 1);
  out.push(b);
}

/** Decode one MessagePack value (the whole buffer). Integers beyond 2^53
 * decode as BigInt; bin decodes as Buffer (a view into `buf`). */
export function decode(buf) {
  const st = { buf, pos: 0 };
  const v = read(st);
  if (st.pos !== buf.length) throw new Error(`msgpack: ${buf.length - st.pos} trailing bytes`);
  return v;
}

function need(st, n) {
  if (st.pos + n > st.buf.length) throw new Error("msgpack: truncated");
}

function read(st) {
  need(st, 1);
  const b = st.buf;
  const t = b[st.pos++];
  if (t < 0x80) return t;
  if (t >= 0xe0) return t - 0x100;
  if ((t & 0xf0) === 0x80) return readMap(st, t & 0x0f);
  if ((t & 0xf0) === 0x90) return readArray(st, t & 0x0f);
  if ((t & 0xe0) === 0xa0) return readStr(st, t & 0x1f);
  const take = (n) => {
    need(st, n);
    const p = st.pos;
    st.pos += n;
    return p;
  };
  switch (t) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xc4: return readBin(st, b[take(1)]);
    case 0xc5: return readBin(st, b.readUInt16BE(take(2)));
    case 0xc6: return readBin(st, b.readUInt32BE(take(4)));
    case 0xca: return b.readFloatBE(take(4));
    case 0xcb: return b.readDoubleBE(take(8));
    case 0xcc: return b[take(1)];
    case 0xcd: return b.readUInt16BE(take(2));
    case 0xce: return b.readUInt32BE(take(4));
    case 0xcf: return safe(b.readBigUInt64BE(take(8)));
    case 0xd0: return b.readInt8(take(1));
    case 0xd1: return b.readInt16BE(take(2));
    case 0xd2: return b.readInt32BE(take(4));
    case 0xd3: return safe(b.readBigInt64BE(take(8)));
    case 0xd9: return readStr(st, b[take(1)]);
    case 0xda: return readStr(st, b.readUInt16BE(take(2)));
    case 0xdb: return readStr(st, b.readUInt32BE(take(4)));
    case 0xdc: return readArray(st, b.readUInt16BE(take(2)));
    case 0xdd: return readArray(st, b.readUInt32BE(take(4)));
    case 0xde: return readMap(st, b.readUInt16BE(take(2)));
    case 0xdf: return readMap(st, b.readUInt32BE(take(4)));
    default:
      throw new Error(`msgpack: unsupported type 0x${t.toString(16)}`);
  }
}

function safe(n) {
  return n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : n;
}
function readStr(st, n) {
  need(st, n);
  const s = st.buf.toString("utf8", st.pos, st.pos + n);
  st.pos += n;
  return s;
}
function readBin(st, n) {
  need(st, n);
  const v = st.buf.subarray(st.pos, st.pos + n);
  st.pos += n;
  return v;
}
function readArray(st, n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = read(st);
  return a;
}
function readMap(st, n) {
  const o = Object.create(null);
  for (let i = 0; i < n; i++) {
    const k = read(st);
    o[String(k)] = read(st);
  }
  return o;
}

/** Split an externally tagged Rust enum value into [variant, content]. */
export function variant(v) {
  if (typeof v === "string") return [v, null];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1) return [keys[0], v[keys[0]]];
  }
  throw new Error("not an enum value");
}
