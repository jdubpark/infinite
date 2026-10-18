import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
// Read-only cmux executable boundary: lifecycle and admission belong to the host.
if (process.argv[2] === "rpc") {
  const method = process.argv[3];
  const observations = {
    "system.tree": { windows: [{ workspaces: [{ id: "external-workspace", panes: [{ surfaces: [{ id: "external-surface", type: "terminal", title: "External task" }] }] }] }] },
    "vault.sessions": { sessions: [] }, "feed.list": { items: [] },
  };
  if (!(method in observations)) throw new Error("The handoff must not mutate the external cmux session");
  console.log(JSON.stringify(observations[method]));
  process.exit(0);
}
if (process.argv[2] === "--delayed-child") {
  process.on("SIGHUP", () => {}); process.on("SIGTERM", () => {});
  writeFileSync(process.argv[3], String(process.pid));
  setInterval(() => writeFileSync("late-child.txt", "A source descendant still has write access.\n"), 2500);
  await new Promise(() => {});
}
const [receiptDir, ...args] = process.argv.slice(2);
const assignment = JSON.parse(process.env.INFINITE_TEAM_ASSIGNMENT ?? "null");
process.stdin.resume();
if (assignment) {
  const response = await fetch(`${process.env.INFINITE_HOOK_URL}/team-report`, {
    method: "POST", headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...assignment, role: undefined, requestId: randomUUID(), report: { kind: "no-change", summary: "The inspected checkpoint needs no parallel implementation.", evidence: [{ source: "original.txt", observation: "The bounded fixture is already complete." }] } }),
  });
  if (response.status !== 204) throw new Error(`Team fixture report refused: ${response.status}`);
} else {
  if (args.includes("Exercise delayed child")) {
    const child = spawn(process.execPath, [process.argv[1], "--delayed-child", join(receiptDir, "child-pid")], { stdio: "ignore" });
    child.unref();
  }
  let server;
  const mcp = args.indexOf("--mcp-config");
  if (mcp >= 0) server = JSON.parse(args[mcp + 1]).mcpServers.infinite_handoff;
  else {
    const settings = {};
    for (let i = 0; i < args.length - 1; i++) if (args[i] === "-c" && args[i + 1].startsWith("mcp_servers.infinite_handoff.")) {
      const item = args[++i].slice("mcp_servers.infinite_handoff.".length), equals = item.indexOf("=");
      settings[item.slice(0, equals)] = JSON.parse(item.slice(equals + 1));
    }
    if (settings.command) server = { command: settings.command, args: settings.args, env: {
      ...Object.fromEntries(settings.env_vars.map(name => [name, process.env[name]])),
      INFINITE_HANDOFF_SESSION: settings["env.INFINITE_HANDOFF_SESSION"],
    } };
  }
  if (server) server.env = Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, /^\$\{[A-Z_]+\}$/.test(value) ? process.env[value.slice(2, -1)] : value]));
  writeFileSync(join(receiptDir, `${process.pid}.json`), JSON.stringify({ argv: args, pid: process.pid, server }), { mode: 0o600 });
}
