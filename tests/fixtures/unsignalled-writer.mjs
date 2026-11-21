// Stands in for the team launcher when the real writer runs as another account: `bundle create` starts a
// writer in its own session, so the host's group kill cannot reach it. The writer inherits this process's
// stdout and writes without end, as a Git process does: each write blocks until the pipe takes it. When a
// write fails, the writer records the error's code in END_FILE and ends. Every other Git command runs as given.
// Usage: unsignalled-writer.mjs END_FILE git GIT_ARGS...
import { spawn, spawnSync } from "node:child_process";

const [endFile, ...command] = process.argv.slice(2);
if (!(command.includes("bundle") && command.includes("create"))) {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const script = `
const { renameSync, writeFileSync, writeSync } = require("node:fs");
const chunk = Buffer.alloc(65536, 97);
for (;;) {
  try { writeSync(1, chunk); } catch (error) {
    // A pipe that is full and does not block: wait, then write again.
    if (error.code === "EAGAIN") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); continue; }
    // The reader sees the whole code or no file: the name appears only after the text is written.
    try { writeFileSync(process.argv[1] + ".part", String(error.code)); renameSync(process.argv[1] + ".part", process.argv[1]); } catch { /* The test's directory is gone. */ }
    process.exit(0);
  }
}`;
const writer = spawn(process.execPath, ["-e", script, endFile], { stdio: ["ignore", "inherit", "ignore"], detached: true });
// This process lives as long as its writer, unless the host ends it first.
writer.once("exit", () => process.exit(0));
