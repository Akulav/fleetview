// BLAKE2b (RFC 7693) and Argon2 d / id, version 1.3 (RFC 9106), in plain JS.
// Used only to open KeePass .kdbx files in the browser (their key is derived
// with Argon2). Runs unchanged in Node, where the tests compare it with
// node:crypto's own blake2b512 and argon2Sync.
//
// 64-bit words are stored as (low, high) pairs of 32-bit integers.

// ---------------------------------------------------------------- BLAKE2b --

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
].map((x) => x * 2);

// v[a] += v[b] (64-bit)
function add64aa(v, a, b) {
  const o0 = v[a] + v[b];
  let o1 = v[a + 1] + v[b + 1];
  if (o0 >= 0x100000000) o1++;
  v[a] = o0;
  v[a + 1] = o1;
}
// v[a] += (b0, b1)
function add64ac(v, a, b0, b1) {
  const o0 = v[a] + b0;
  let o1 = v[a + 1] + b1;
  if (o0 >= 0x100000000) o1++;
  v[a] = o0;
  v[a + 1] = o1;
}

function B2B_G(v, m, a, b, c, d, ix, iy) {
  const x0 = m[ix], x1 = m[ix + 1], y0 = m[iy], y1 = m[iy + 1];
  add64aa(v, a, b);
  add64ac(v, a, x0, x1);
  let xor0 = v[d] ^ v[a], xor1 = v[d + 1] ^ v[a + 1];
  v[d] = xor1;
  v[d + 1] = xor0;
  add64aa(v, c, d);
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor0 >>> 24) ^ (xor1 << 8);
  v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8);
  add64aa(v, a, b);
  add64ac(v, a, y0, y1);
  xor0 = v[d] ^ v[a];
  xor1 = v[d + 1] ^ v[a + 1];
  v[d] = (xor0 >>> 16) ^ (xor1 << 16);
  v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16);
  add64aa(v, c, d);
  xor0 = v[b] ^ v[c];
  xor1 = v[b + 1] ^ v[c + 1];
  v[b] = (xor1 >>> 31) ^ (xor0 << 1);
  v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1);
}

const vv = new Uint32Array(32);
const mm = new Uint32Array(32);

function compress(ctx, last) {
  const v = vv, m = mm;
  for (let i = 0; i < 16; i++) {
    v[i] = ctx.h[i];
    v[i + 16] = IV[i];
  }
  v[24] ^= ctx.t;
  v[25] ^= ctx.t / 0x100000000;
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  const b = ctx.b;
  for (let i = 0; i < 32; i++) m[i] = b[i * 4] | (b[i * 4 + 1] << 8) | (b[i * 4 + 2] << 16) | (b[i * 4 + 3] << 24);
  for (let i = 0; i < 12; i++) {
    const s = i * 16;
    B2B_G(v, m, 0, 8, 16, 24, SIGMA[s + 0], SIGMA[s + 1]);
    B2B_G(v, m, 2, 10, 18, 26, SIGMA[s + 2], SIGMA[s + 3]);
    B2B_G(v, m, 4, 12, 20, 28, SIGMA[s + 4], SIGMA[s + 5]);
    B2B_G(v, m, 6, 14, 22, 30, SIGMA[s + 6], SIGMA[s + 7]);
    B2B_G(v, m, 0, 10, 20, 30, SIGMA[s + 8], SIGMA[s + 9]);
    B2B_G(v, m, 2, 12, 22, 24, SIGMA[s + 10], SIGMA[s + 11]);
    B2B_G(v, m, 4, 14, 16, 26, SIGMA[s + 12], SIGMA[s + 13]);
    B2B_G(v, m, 6, 8, 18, 28, SIGMA[s + 14], SIGMA[s + 15]);
  }
  for (let i = 0; i < 16; i++) ctx.h[i] ^= v[i] ^ v[i + 16];
}

export function blake2bInit(outlen) {
  if (outlen < 1 || outlen > 64) throw new Error("blake2b output must be 1..64 bytes");
  const ctx = { b: new Uint8Array(128), h: new Uint32Array(16), t: 0, c: 0, outlen };
  for (let i = 0; i < 16; i++) ctx.h[i] = IV[i];
  ctx.h[0] ^= 0x01010000 ^ outlen;
  return ctx;
}

export function blake2bUpdate(ctx, input) {
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === 128) {
      ctx.t += ctx.c;
      compress(ctx, false);
      ctx.c = 0;
    }
    ctx.b[ctx.c++] = input[i];
  }
}

export function blake2bFinal(ctx) {
  ctx.t += ctx.c;
  while (ctx.c < 128) ctx.b[ctx.c++] = 0;
  compress(ctx, true);
  const out = new Uint8Array(ctx.outlen);
  for (let i = 0; i < ctx.outlen; i++) out[i] = ctx.h[i >> 2] >>> (8 * (i & 3));
  return out;
}

export function blake2b(input, outlen = 64) {
  const ctx = blake2bInit(outlen);
  blake2bUpdate(ctx, input);
  return blake2bFinal(ctx);
}

// ----------------------------------------------------------------- Argon2 --

const le32 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

/** H' — variable-length hash (RFC 9106 §3.3). */
function hPrime(input, T) {
  if (T <= 64) {
    const ctx = blake2bInit(T);
    blake2bUpdate(ctx, le32(T));
    blake2bUpdate(ctx, input);
    return blake2bFinal(ctx);
  }
  const out = new Uint8Array(T);
  const r = Math.ceil(T / 32) - 2;
  const ctx = blake2bInit(64);
  blake2bUpdate(ctx, le32(T));
  blake2bUpdate(ctx, input);
  let v = blake2bFinal(ctx);
  out.set(v.subarray(0, 32), 0);
  for (let i = 1; i < r; i++) {
    v = blake2b(v, 64);
    out.set(v.subarray(0, 32), i * 32);
  }
  out.set(blake2b(v, T - 32 * r), r * 32);
  return out;
}

// 2 * lo32(x) * lo32(y) as a 64-bit (lo, hi) pair, written to MUL[0..1].
const MUL = new Uint32Array(2);
function mul2(x, y) {
  const xl = x & 0xffff, xh = x >>> 16, yl = y & 0xffff, yh = y >>> 16;
  const ll = xl * yl, mid = xl * yh + xh * yl, hh = xh * yh;
  let lo = ll + (mid % 0x10000) * 0x10000;
  let hi = hh + Math.floor(mid / 0x10000) + Math.floor(lo / 0x100000000);
  lo = lo % 0x100000000;
  // × 2
  hi = (hi * 2 + Math.floor(lo / 0x80000000)) % 0x100000000;
  lo = (lo * 2) % 0x100000000;
  MUL[0] = lo;
  MUL[1] = hi;
}

// a += b + 2·lo(a)·lo(b) on registers r (pairs), indexes are word*2.
function fBlaMka(r, a, b) {
  mul2(r[a], r[b]);
  add64aa(r, a, b);
  add64ac(r, a, MUL[0], MUL[1]);
}

function GB(r, a, b, c, d) {
  fBlaMka(r, a, b);
  let x0 = r[d] ^ r[a], x1 = r[d + 1] ^ r[a + 1];
  r[d] = x1;
  r[d + 1] = x0;
  fBlaMka(r, c, d);
  x0 = r[b] ^ r[c];
  x1 = r[b + 1] ^ r[c + 1];
  r[b] = (x0 >>> 24) ^ (x1 << 8);
  r[b + 1] = (x1 >>> 24) ^ (x0 << 8);
  fBlaMka(r, a, b);
  x0 = r[d] ^ r[a];
  x1 = r[d + 1] ^ r[a + 1];
  r[d] = (x0 >>> 16) ^ (x1 << 16);
  r[d + 1] = (x1 >>> 16) ^ (x0 << 16);
  fBlaMka(r, c, d);
  x0 = r[b] ^ r[c];
  x1 = r[b + 1] ^ r[c + 1];
  r[b] = (x1 >>> 31) ^ (x0 << 1);
  r[b + 1] = (x0 >>> 31) ^ (x1 << 1);
}

// The permutation P on 16 64-bit words given by their word indexes.
const REG = new Uint32Array(32);
function P(R, idx) {
  const r = REG;
  for (let i = 0; i < 16; i++) {
    r[2 * i] = R[2 * idx[i]];
    r[2 * i + 1] = R[2 * idx[i] + 1];
  }
  GB(r, 0, 8, 16, 24);
  GB(r, 2, 10, 18, 26);
  GB(r, 4, 12, 20, 28);
  GB(r, 6, 14, 22, 30);
  GB(r, 0, 10, 20, 30);
  GB(r, 2, 12, 22, 24);
  GB(r, 4, 14, 16, 26);
  GB(r, 6, 8, 18, 28);
  for (let i = 0; i < 16; i++) {
    R[2 * idx[i]] = r[2 * i];
    R[2 * idx[i] + 1] = r[2 * i + 1];
  }
}

const ROWS = [], COLS = [];
for (let i = 0; i < 8; i++) {
  ROWS.push(Array.from({ length: 16 }, (_, j) => 16 * i + j));
  const c = [];
  for (let k = 0; k < 8; k++) c.push(2 * i + 16 * k, 2 * i + 16 * k + 1);
  COLS.push(c);
}

const Rb = new Uint32Array(256);
const Tb = new Uint32Array(256);
/** next = G(prev, ref) [^ next] — blocks are 256-word views into memory. */
function fillBlock(mem, prev, ref, next, withXor) {
  for (let i = 0; i < 256; i++) Rb[i] = mem[prev + i] ^ mem[ref + i];
  for (let i = 0; i < 256; i++) Tb[i] = withXor ? Rb[i] ^ mem[next + i] : Rb[i];
  for (const row of ROWS) P(Rb, row);
  for (const col of COLS) P(Rb, col);
  for (let i = 0; i < 256; i++) mem[next + i] = Tb[i] ^ Rb[i];
}

/** Same as fillBlock but on standalone 256-word arrays (address blocks). */
function fillStandalone(prev, ref, out) {
  for (let i = 0; i < 256; i++) Rb[i] = prev[i] ^ ref[i];
  Tb.set(Rb);
  for (const row of ROWS) P(Rb, row);
  for (const col of COLS) P(Rb, col);
  for (let i = 0; i < 256; i++) out[i] = Tb[i] ^ Rb[i];
}

export const ARGON2D = 0;
export const ARGON2I = 1;
export const ARGON2ID = 2;

/**
 * Argon2 (version 0x13). `memoryKiB` like the reference implementation.
 * `onProgress(fraction)` is called now and then (for long imports).
 */
export function argon2({ password, salt, secret = new Uint8Array(0), ad = new Uint8Array(0), iterations, memoryKiB, parallelism, hashLength = 32, type = ARGON2D, version = 0x13, onProgress }) {
  if (version !== 0x13) throw new Error("only Argon2 version 1.3 is supported");
  const p = parallelism;
  const m = Math.max(memoryKiB, 8 * p);
  const mPrime = 4 * p * Math.floor(m / (4 * p));
  const q = mPrime / p; // lane length
  const segLen = q / 4;

  const parts = [le32(p), le32(hashLength), le32(m), le32(iterations), le32(version), le32(type), le32(password.length), password, le32(salt.length), salt, le32(secret.length), secret, le32(ad.length), ad];
  const ctx = blake2bInit(64);
  for (const x of parts) blake2bUpdate(ctx, x);
  const h0 = blake2bFinal(ctx);

  const mem = new Uint32Array(mPrime * 256);
  const seed = new Uint8Array(72);
  seed.set(h0, 0);
  const putBlock = (bytes, blockIndex) => {
    const base = blockIndex * 256;
    for (let i = 0; i < 256; i++) mem[base + i] = bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24);
  };
  for (let l = 0; l < p; l++) {
    seed.set(le32(0), 64);
    seed.set(le32(l), 68);
    putBlock(hPrime(seed, 1024), l * q);
    seed.set(le32(1), 64);
    putBlock(hPrime(seed, 1024), l * q + 1);
  }

  const zero = new Uint32Array(256);
  const input = new Uint32Array(256);
  const address = new Uint32Array(256);
  const tmp = new Uint32Array(256);
  const nextAddresses = () => {
    input[12]++; // v[6] (64-bit counter, low word)
    fillStandalone(zero, input, tmp);
    fillStandalone(zero, tmp, address);
  };

  const total = iterations * 4;
  let done = 0;
  for (let pass = 0; pass < iterations; pass++) {
    for (let slice = 0; slice < 4; slice++) {
      for (let lane = 0; lane < p; lane++) {
        const indep = type === ARGON2I || (type === ARGON2ID && pass === 0 && slice < 2);
        if (indep) {
          input.fill(0);
          input[0] = pass;
          input[2] = lane;
          input[4] = slice;
          input[6] = mPrime;
          input[8] = iterations;
          input[10] = type;
        }
        let start = 0;
        if (pass === 0 && slice === 0) {
          start = 2;
          if (indep) nextAddresses();
        }
        let cur = lane * q + slice * segLen + start;
        let prev = cur % q === 0 ? cur + q - 1 : cur - 1;
        for (let i = start; i < segLen; i++, cur++, prev++) {
          if (cur % q === 1) prev = cur - 1;
          let j1, j2;
          if (indep) {
            if (i % 128 === 0) nextAddresses();
            j1 = address[2 * (i % 128)];
            j2 = address[2 * (i % 128) + 1];
          } else {
            j1 = mem[prev * 256];
            j2 = mem[prev * 256 + 1];
          }
          let refLane = j2 % p;
          if (pass === 0 && slice === 0) refLane = lane;
          const same = refLane === lane;
          let area;
          if (pass === 0) {
            if (slice === 0) area = i - 1;
            else area = same ? slice * segLen + i - 1 : slice * segLen + (i === 0 ? -1 : 0);
          } else {
            area = same ? q - segLen + i - 1 : q - segLen + (i === 0 ? -1 : 0);
          }
          const J1 = BigInt(j1 >>> 0);
          let rel = (J1 * J1) >> 32n;
          rel = BigInt(area) - 1n - ((BigInt(area) * rel) >> 32n);
          const startPos = pass !== 0 && slice !== 3 ? (slice + 1) * segLen : 0;
          const refIndex = Number((BigInt(startPos) + rel) % BigInt(q));
          fillBlock(mem, prev * 256, (refLane * q + refIndex) * 256, cur * 256, pass !== 0);
        }
      }
      done++;
      onProgress?.(done / total);
    }
  }

  const last = new Uint32Array(256);
  for (let l = 0; l < p; l++) {
    const base = (l * q + q - 1) * 256;
    for (let i = 0; i < 256; i++) last[i] ^= mem[base + i];
  }
  const bytes = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    bytes[i * 4] = last[i];
    bytes[i * 4 + 1] = last[i] >>> 8;
    bytes[i * 4 + 2] = last[i] >>> 16;
    bytes[i * 4 + 3] = last[i] >>> 24;
  }
  return hPrime(bytes, hashLength);
}
