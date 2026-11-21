// Stands in for the team launcher when the real writer runs as another account: `bundle create` starts a
// writer in its own session, so the host's group kill cannot reach it, and the writer inherits this
// process's stdout and writes without end. Every other Git command runs as given.
// Usage: unsignalled-writer.mjs PID_FILE git GIT_ARGS...
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidFile, ...command] = process.argv.slice(2);
if (!(command.includes("bundle") && command.includes("create"))) {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const writer = spawn(process.execPath, ["-e", "const chunk = Buffer.alloc(65536, 97); (function write() { while (process.stdout.write(chunk)); process.stdout.once('drain', write); })();"], { stdio: ["ignore", "inherit", "ignore"], detached: true });
writeFileSync(pidFile, String(writer.pid));
// This process lives as long as its writer, so ending the writer leaves nothing behind.
writer.once("exit", () => process.exit(0));
