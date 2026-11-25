// Opens a .kdbx file off the main thread (Argon2 / AES-KDF can take seconds).
// The KeePass master password stays inside this browser tab.
import { readKdbx } from "./kdbx.js";

self.onmessage = async (e) => {
  const { buf, password } = e.data;
  try {
    let last = 0;
    const result = await readKdbx(buf, password, {
      onProgress: (p) => {
        if (p - last >= 0.02 || p === 1) {
          last = p;
          self.postMessage({ progress: p });
        }
      },
    });
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: err.message, code: err.code ?? null });
  }
};
