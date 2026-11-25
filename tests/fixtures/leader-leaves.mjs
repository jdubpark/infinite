import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [record, mode, ...rest] = process.argv.slice(2);
if (mode === "bundle" && !(rest.includes("bundle") && rest.includes("create")))
  process.exit(spawnSync(rest[0], rest.slice(1), { stdio: "inherit" }).status ?? 1);
const idle = ["-e", "setTimeout(() => {}, 30000)"];
const holder = spawn(process.execPath, idle, { detached: true, stdio: ["ignore", "inherit", "inherit"] });
const witness = spawn(process.execPath, idle, { stdio: "ignore" });
holder.unref();
witness.unref();
writeFileSync(record, `${JSON.stringify({ leader: process.pid, holder: holder.pid, witness: witness.pid })}\n`);
if (mode === "print") process.stdout.write(rest[0]);
const status = mode === "print" ? 0 : spawnSync(rest[0], rest.slice(1), { stdio: "inherit" }).status ?? 1;
setTimeout(() => process.exit(status), 300);
