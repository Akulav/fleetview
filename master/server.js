#!/usr/bin/env node
// FleetView master — `npm start`. Configuration: see .env.example / README.

import { loadDotEnv } from "./src/config.js";
import { startMaster } from "./src/master.js";

loadDotEnv();
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`FleetView needs Node.js 20 or newer (this is ${process.versions.node}).`);
  process.exit(1);
}

let master;
try {
  master = await startMaster();
} catch (e) {
  console.error(`FleetView master failed to start: ${e.message}`);
  if (e.code === "EADDRINUSE") console.error("Another program (or another master) is using that port.");
  process.exit(1);
}

const stop = async () => {
  master.logs.write("shutting down");
  await master.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
