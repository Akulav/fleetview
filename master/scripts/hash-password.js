#!/usr/bin/env node
// Prints a FLEETVIEW_ADMIN_PASSWORD_HASH line for .env.
//   npm run hash-password            (asks for the password, not echoed)
//   echo pw | npm run hash-password  (reads it from stdin)

import { hashPassword } from "../src/auth.js";

async function readPassword() {
  if (!process.stdin.isTTY) {
    let s = "";
    for await (const c of process.stdin) s += c;
    return s.replace(/\r?\n$/, "");
  }
  process.stdout.write("New console password: ");
  process.stdin.setRawMode(true);
  let pw = "";
  for await (const c of process.stdin) {
    for (const ch of c.toString("utf8")) {
      if (ch === "\r" || ch === "\n") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        return pw;
      }
      if (ch === "\u0003") process.exit(1);
      if (ch === "\u007f" || ch === "\b") pw = pw.slice(0, -1);
      else pw += ch;
    }
  }
  return pw;
}

const pw = await readPassword();
if (pw.length < 10) {
  console.error("Use at least 10 characters.");
  process.exit(1);
}
console.log(`FLEETVIEW_ADMIN_PASSWORD_HASH=${hashPassword(pw)}`);
process.exit(0);
