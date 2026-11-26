import { spawn, spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

const [record, mode, ...rest] = process.argv.slice(2);
const [action, ending] = mode.split("-");
const leads = () => {
  try {
    process.kill(-process.pid, 0);
    return true;
  } catch {
    return false;
  }
};
const group = leads() ? process.pid : process.ppid;
const save = left => {
  writeFileSync(`${record}.next`, `${JSON.stringify({ leader: process.pid, group, ...left })}\n`);
  renameSync(`${record}.next`, record);
};
if (action === "bundle" && !(rest.includes("bundle") && rest.includes("create")))
  process.exit(spawnSync(rest[0], rest.slice(1), { stdio: "inherit" }).status ?? 1);
if (ending === "running" || ending === "stubborn") {
  if (ending === "stubborn") process.on("SIGTERM", () => {});
  const stubborn = "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setTimeout(() => {}, 30000)";
  const member = spawn(process.execPath, ["-e", stubborn], { stdio: ["ignore", "pipe", "ignore"] });
  save({ member: member.pid });
  member.stdout.once("data", () => {
    member.stdout.destroy();
    member.unref();
    save({ member: member.pid, ready: true });
  });
  if (action === "print") process.stdout.write(rest[0]);
  else if (rest.length) spawnSync(rest[0], rest.slice(1), { stdio: "inherit" });
  setTimeout(() => process.exit(0), 30000);
} else {
  const idle = ["-e", "setTimeout(() => {}, 30000)"];
  const holder = spawn(process.execPath, idle, { detached: true, stdio: ["ignore", ending === "stderr" ? "ignore" : "inherit", "inherit"] });
  const witness = ending === "alone" ? undefined : spawn(process.execPath, idle, { stdio: "ignore" });
  holder.unref();
  witness?.unref();
  save({ holder: holder.pid, ...(witness ? { witness: witness.pid } : {}) });
  if (action === "print") process.stdout.write(rest[0]);
  const status = action === "print" ? 0 : spawnSync(rest[0], rest.slice(1), { stdio: "inherit" }).status ?? 1;
  setTimeout(() => ending === "killed" ? process.kill(process.pid, "SIGKILL") : process.exit(status), 300);
}
