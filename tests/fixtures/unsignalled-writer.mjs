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
    // A full socket that does not block: wait, then write again.
    if (error.code === "EAGAIN") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); continue; }
    // The reader sees the whole code or no file: the name appears only after the text is written.
    try { writeFileSync(process.argv[1] + ".part", String(error.code)); renameSync(process.argv[1] + ".part", process.argv[1]); } catch { /* The test's directory is gone. */ }
    process.exit(0);
  }
}`;
const writer = spawn(process.execPath, ["-e", script, endFile], { stdio: ["ignore", "inherit", "ignore"], detached: true });
writer.once("exit", () => process.exit(0));
