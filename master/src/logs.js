// Activity log: console + daily file in <data>/logs + a ring buffer for the UI.

import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export class Logs extends EventEmitter {
  constructor(dataDir, { quiet = false } = {}) {
    super();
    this.dir = join(dataDir, "logs");
    mkdirSync(this.dir, { recursive: true });
    this.ring = [];
    this.quiet = quiet;
  }
  write(message) {
    const line = { at: new Date().toISOString(), message: String(message) };
    this.ring.push(line);
    if (this.ring.length > 500) this.ring.shift();
    if (!this.quiet) console.log(`${line.at}  ${line.message}`);
    try {
      appendFileSync(join(this.dir, `master-${line.at.slice(0, 10)}.log`), `${line.at}  ${line.message}\n`);
    } catch {
      /* the log must never take the master down */
    }
    this.emit("line", line);
  }
  recent() {
    return this.ring.slice(-200);
  }
}
