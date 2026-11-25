import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [record, mode, ...rest] = process.argv.slice(2);
const save = left => writeFileSync(record, `${JSON.stringify({ leader: process.pid, ...left })}\n`);
if (mode === "bundle" && !(rest.includes("bundle") && rest.includes("create")))
  process.exit(spawnSync(rest[0], rest.slice(1), { stdio: "inherit" }).status ?? 1);
if (mode === "running") {
  const stubborn = "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setTimeout(() => {}, 30000)";
  const member = spawn(process.execPath, ["-e", stubborn], { stdio: ["ignore", "pipe", "ignore"] });
  member.stdout.once("data", () => {
    member.stdout.destroy();
    member.unref();
    save({ member: member.pid });
  });
  process.stdout.write(rest[0]);
  setTimeout(() => process.exit(0), 30000);
} else {
  const [action, ending] = mode.split("-");
  const idle = ["-e", "setTimeout(() => {}, 30000)"];
  const holder = spawn(process.execPath, idle, { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  const witness = spawn(process.execPath, idle, { stdio: "ignore" });
  holder.unref();
  witness.unref();
  save({ holder: holder.pid, witness: witness.pid });
  if (action === "print") process.stdout.write(rest[0]);
  const status = action === "print" ? 0 : spawnSync(rest[0], rest.slice(1), { stdio: "inherit" }).status ?? 1;
  setTimeout(() => ending === "killed" ? process.kill(process.pid, "SIGKILL") : process.exit(status), 300);
}
