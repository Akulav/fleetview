// Just enough DER to make the master's self-signed TLS certificate with
// Node's built-in crypto (no openssl, no dependencies). The agent pins the
// certificate's SHA-256 fingerprint and checks the handshake signature, so all
// that matters is a well-formed X.509 v3 certificate with an ECDSA P-256 key.

import crypto from "node:crypto";

const len = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, ...content) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...c) => tlv(0x30, ...c);
const set = (...c) => tlv(0x31, ...c);
const oid = (dotted) => {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const b = [p & 0x7f];
    let v = p >> 7;
    while (v > 0) {
      b.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const time = (d) => {
  // GeneralizedTime is valid for every year; UTCTime only until 2049.
  const s = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(s.slice(2))) : tlv(0x18, Buffer.from(s));
};
const bitString = (buf) => tlv(0x03, Buffer.from([0]), buf);
const explicit = (n, ...c) => tlv(0xa0 | n, ...c);

/** A fresh ECDSA P-256 key and a self-signed certificate for `commonName`
 * (with the same DNS SAN). Returns PEM strings and the DER of the cert. */
export function selfSignedCert(commonName = "fleetview-master", years = 30) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(set(seq(oid("2.5.4.3"), utf8(commonName))));
  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(now.getUTCFullYear() + years);
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const san = seq(oid("2.5.29.17"), tlv(0x04, seq(tlv(0x82, Buffer.from(commonName)))));
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))), // v3
    int(serial),
    ecdsaSha256,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
    explicit(3, seq(san)),
  );
  const sig = crypto.sign("sha256", tbs, privateKey); // DER ECDSA-Sig-Value
  const der = seq(tbs, ecdsaSha256, bitString(sig));
  const pem = (label, b) =>
    `-----BEGIN ${label}-----\n${b.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
  return {
    certPem: pem("CERTIFICATE", der),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    der,
  };
}

/** DER bytes of the first certificate in a PEM string. */
export function pemToDer(pem) {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
  if (!m) throw new Error("no certificate in PEM");
  return Buffer.from(m[1].replace(/\s+/g, ""), "base64");
}
