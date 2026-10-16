import { parseArgs } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { hashToken, readConfig } from "./config.js";
import { createRelayServer } from "./relay.js";

const commands = new Set(["machine-info", "project-add", "device-add", "device-revoke", "connect-relay", "relay-init", "relay-add", "relay-serve", "install-service", "uninstall-service"]);
function writePrivate(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}
const relaySchema = z.object({
  port: z.number().int().min(1).max(65535),
  registrations: z.array(z.object({ machineId: z.uuid(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(256),
}).strict();
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const systemd = (value: string) => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("\n", "\\n") + '"';

export async function handleMachineCommand(argv: string[]) {
  if (!commands.has(argv[0])) return false;
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    config: { type: "string" }, name: { type: "string" }, role: { type: "string" },
    "token-file": { type: "string" }, machine: { type: "string" }, port: { type: "string" },
  } });
  const command = positionals[0];
  const file = resolve(values.config ?? process.env.INFINITE_CONFIG ?? join(homedir(), ".config/infinite", command.startsWith("relay-") ? "relay.json" : "config.json"));
  if (command === "relay-init") {
    if (existsSync(file)) throw new Error("Relay configuration already exists");
    writePrivate(file, relaySchema.parse({ port: Number(values.port ?? 4790), registrations: [] }));
    console.log("Created private relay configuration. Register machines before exposing its HTTPS endpoint.");
    return true;
  }
  if (command.startsWith("relay-")) {
    if (statSync(file).mode & 0o077) throw new Error("Relay configuration must be private (mode 600)");
    const config = relaySchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (command === "relay-add") {
      const machineId = z.uuid().parse(values.machine);
      if (!values["token-file"]) throw new Error("Supply --token-file for the private registration key");
      if (config.registrations.some(r => r.machineId === machineId)) throw new Error("Machine is already registered");
      const tokenFile = resolve(values["token-file"]);
      if (existsSync(tokenFile)) throw new Error("Registration key output already exists");
      const token = randomBytes(32).toString("base64url");
      const next = relaySchema.parse({ ...config, registrations: [...config.registrations, { machineId, tokenHash: hashToken(token) }] });
      mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
      writeFileSync(tokenFile, token + "\n", { mode: 0o600, flag: "wx" });
      writePrivate(file, next);
      console.log("Registered machine. Transfer the private key to that machine, then restart the relay.");
    } else {
      const relay = createRelayServer({ registrations: config.registrations });
      relay.server.listen(config.port, "127.0.0.1", () => console.log(`Infinite relay listening on loopback port ${config.port}. Terminate HTTPS at your reverse proxy.`));
      for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
        relay.close(); relay.server.close(() => process.exit(0));
      });
    }
    return true;
  }
  const { config } = readConfig(file);
  if (command === "machine-info") {
    console.log(JSON.stringify({ ...config.machine, environment: config.environment, projects: config.projects.map(({ id, name }) => ({ id, name })), cmux: Boolean(config.cmux?.enabled), remote: Boolean(config.remote?.enabled), relay: config.remote?.relay?.url }, null, 2));
  } else if (command === "project-add") {
    const id = z.string().regex(/^[a-z0-9-]{1,80}$/).parse(positionals[1]);
    if (!positionals[2]) throw new Error("Supply a project id and directory");
    if (config.projects.some(p => p.id === id)) throw new Error("Project id already exists");
    const path = realpathSync(resolve(positionals[2]));
    if (!statSync(path).isDirectory() || path === homedir() || path === resolve("/")) throw new Error("Select a project directory, not the entire home or filesystem");
    config.projects.push({ id, name: z.string().trim().min(1).max(100).parse(values.name ?? id), path });
    writePrivate(file, config);
    console.log("Project added. Restart the host API to apply it; running workers stay alive.");
  } else if (command === "device-add") {
    const role = z.enum(["owner", "controller", "viewer"]).parse(values.role ?? "controller");
    const label = z.string().trim().min(1).max(80).parse(values.name ?? "Paired device");
    if (!values["token-file"]) throw new Error("Supply --token-file for the new device key");
    const tokenFile = resolve(values["token-file"]);
    if (existsSync(tokenFile)) throw new Error("Device key output already exists");
    const token = randomBytes(32).toString("base64url");
    const id = randomUUID();
    mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile, token + "\n", { mode: 0o600, flag: "wx" });
    config.tokens.push({ id, label, role, hash: hashToken(token) });
    writePrivate(file, config);
    console.log(`Added device ${id} (${role}). Restart the host API before pairing with its private key file.`);
  } else if (command === "device-revoke") {
    const device = config.tokens.find(t => t.id === positionals[1]);
    if (!device) throw new Error("Unknown device id");
    if (config.tokens.length < 2 || (device.role === "owner" && config.tokens.filter(t => t.role === "owner").length < 2)) throw new Error("Keep at least one owner device");
    config.tokens = config.tokens.filter(t => t !== device);
    writePrivate(file, config);
    console.log("Device removed from configuration. Restart the host API now to revoke its active connections.");
  } else if (command === "connect-relay") {
    if (!positionals[1] || !values["token-file"]) throw new Error("Supply the relay HTTPS origin and --token-file");
    const tokenFile = realpathSync(resolve(values["token-file"]));
    const next = { ...config, remote: { enabled: true, relay: { url: positionals[1], tokenFile } } };
    // Validate the complete prospective configuration before replacing the current file.
    const check = `${file}.${randomUUID()}.check`;
    try { writePrivate(check, next); readConfig(check); } finally { if (existsSync(check)) unlinkSync(check); }
    writePrivate(file, next);
    console.log("Relay configured. Restart the host API to connect; pairing still requires a device key.");
  } else {
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    if (!existsSync(cli)) throw new Error("Build the host and run its compiled CLI before installing the service");
    const args = [process.execPath, cli, "serve", "--config", file];
    if (process.platform === "darwin") {
      const label = "dev.infinite.host";
      const service = join(homedir(), "Library/LaunchAgents", label + ".plist");
      const domain = `gui/${process.getuid!()}`;
      if (command === "uninstall-service") {
        if (existsSync(service)) { try { execFileSync("launchctl", ["bootout", domain, service]); } catch {} unlinkSync(service); }
      } else {
        if (existsSync(service)) throw new Error("Infinite host service already exists; uninstall it before replacing it");
        const logs = join(dirname(file), "host.log");
        const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict><key>StandardOutPath</key><string>${xml(logs)}</string><key>StandardErrorPath</key><string>${xml(logs)}</string></dict></plist>`;
        mkdirSync(dirname(service), { recursive: true, mode: 0o700 });
        writeFileSync(service, plist, { mode: 0o600, flag: "wx" });
        execFileSync("launchctl", ["bootstrap", domain, service]);
      }
    } else if (process.platform === "linux") {
      const service = join(homedir(), ".config/systemd/user/infinite-host.service");
      if (command === "uninstall-service") {
        if (existsSync(service)) { execFileSync("systemctl", ["--user", "disable", "--now", "infinite-host.service"]); unlinkSync(service); }
      } else {
        if (existsSync(service)) throw new Error("Infinite host service already exists; uninstall it before replacing it");
        mkdirSync(dirname(service), { recursive: true, mode: 0o700 });
        writeFileSync(service, `[Unit]\nDescription=Infinite session host\nAfter=network-online.target\n[Service]\nExecStart=${args.map(systemd).join(" ")}\nEnvironment=${systemd("PATH=" + (process.env.PATH ?? "/usr/bin:/bin"))}\nRestart=on-failure\nKillMode=process\n[Install]\nWantedBy=default.target\n`, { mode: 0o600, flag: "wx" });
        execFileSync("systemctl", ["--user", "daemon-reload"]);
        execFileSync("systemctl", ["--user", "enable", "--now", "infinite-host.service"]);
      }
    } else throw new Error("Background service installation supports macOS and Linux");
    console.log(command === "install-service" ? "Infinite host starts at login and runs independently of its clients." : "Infinite host service removed. Session workers were not terminated.");
  }
  return true;
}
