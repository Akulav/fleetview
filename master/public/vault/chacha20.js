// ChaCha20 (RFC 8439), 32-byte key, 12-byte nonce, 32-bit block counter.
// KDBX 4 uses it for protected fields (and optionally as the file cipher).

const C0 = 0x61707865, C1 = 0x3320646e, C2 = 0x79622d32, C3 = 0x6b206574;
const rotl = (x, n) => (x << n) | (x >>> (32 - n));
const rd = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

export class ChaCha20 {
  constructor(key, nonce, counter = 0) {
    if (key.length !== 32 || nonce.length !== 12) throw new Error("ChaCha20 needs a 32-byte key and 12-byte nonce");
    this.state = new Uint32Array([C0, C1, C2, C3, ...Array.from({ length: 8 }, (_, i) => rd(key, i * 4)), counter, rd(nonce, 0), rd(nonce, 4), rd(nonce, 8)]);
    this.block = new Uint8Array(64);
    this.pos = 64;
    this.x = new Uint32Array(16);
  }

  next() {
    const x = this.x;
    x.set(this.state);
    const qr = (a, b, c, d) => {
      x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 16);
      x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 12);
      x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 8);
      x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 7);
    };
    for (let i = 0; i < 10; i++) {
      qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
      qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
    }
    for (let i = 0; i < 16; i++) {
      const v = (x[i] + this.state[i]) >>> 0;
      this.block[i * 4] = v;
      this.block[i * 4 + 1] = v >>> 8;
      this.block[i * 4 + 2] = v >>> 16;
      this.block[i * 4 + 3] = v >>> 24;
    }
    this.state[12]++;
    this.pos = 0;
  }

  /** XOR `data` with the keystream (encrypts and decrypts). Returns a new array. */
  xor(data) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      if (this.pos === 64) this.next();
      out[i] = data[i] ^ this.block[this.pos++];
    }
    return out;
  }
}
