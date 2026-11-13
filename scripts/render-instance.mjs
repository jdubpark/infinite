#!/usr/bin/env node
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reserved = new Set(["agent", "agents", "host", "key", "github", "github-auth", "relay", "workspace", "data", "build", "brain", "backup"]);
const templates = [
  ["infinite.service", name => name ? `infinite-${name}.service` : "infinite.service"],
  ["infinite.sudoers", name => name ? `infinite-${name}.sudoers` : "infinite.sudoers"],
  ["agent-wrapper.sh", () => "agent-wrapper.sh"],
  ["agent-env.sh", () => "agent-env.sh"],
  ["agent-anchor.sh", () => "agent-anchor.sh"],
  ["install-agent-env.sh", () => "install-agent-env.sh"],
  ["infinite-tmpfiles.conf", name => name ? `infinite-${name}-tmpfiles.conf` : "infinite-tmpfiles.conf"],
  ["infinite-github-refresh.service", name => name ? `infinite-${name}-github-refresh.service` : "infinite-github-refresh.service"],
  ["infinite-github-refresh.timer", name => name ? `infinite-${name}-github-refresh.timer` : "infinite-github-refresh.timer"],
  ["github-app-gh.sh", () => "github-app-gh.sh"],
  ["config.example.json", () => "config.example.json"],
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

let out;
let instance;
let port = 4781;
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (!["--out", "--instance", "--port"].includes(flag)) fail(`Unknown option: ${flag}`);
  const value = process.argv[++i];
  if (value === undefined) fail(`Missing value for ${flag}`);
  if (flag === "--out") out = value;
  if (flag === "--instance") instance = value;
  if (flag === "--port") {
    if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
      fail(`Invalid port: ${value}`);
    port = Number(value);
  }
}

if (!out) fail("--out DIR is required.");
if (instance !== undefined && (!/^[a-z][a-z0-9-]{0,15}$/.test(instance) || reserved.has(instance)))
  fail(`Invalid or reserved instance name: ${instance}`);

function instanceText(source, name) {
  if (!name) return source;

  let text = source;
  // Replace the more specific shared-tool paths before their broader prefixes.
  text = text.replace(/\/srv\/infinite-data\//g, `/srv/infinite-data/instances/${name}/`);
  text = text.replaceAll("/opt/infinite-agents/v1", `/srv/infinite-data/instances/${name}/agents/v1`);
  text = text.replace(/\/opt\/infinite(?=\/|[\s"']|$)/g, `/opt/infinite-${name}`);
  text = text.replace(/\/etc\/infinite-github(?=\/|$)/g, `/etc/infinite-${name}-github`);
  text = text.replace(/\/run\/infinite-github(?=\/|$)/g, `/run/infinite-${name}-github`);
  text = text.replace(/RuntimeDirectory=infinite-github(?=\s|$)/gm, `RuntimeDirectory=infinite-${name}-github`);
  text = text.replace(/\/run\/infinite-key\//g, `/run/infinite-${name}-key/`);
  text = text.replace(/\/run\/infinite(?=\/|[\s"']|$)/g, `/run/infinite-${name}`);
  text = text.replace(/RuntimeDirectory=infinite(?=\s|$)/gm, `RuntimeDirectory=infinite-${name}`);
  text = text.replaceAll("/usr/local/libexec/infinite", `/usr/local/libexec/infinite-${name}`);
  text = text.replaceAll("/etc/sudoers.d/infinite", `/etc/sudoers.d/infinite-${name}`);
  text = text.replaceAll("/etc/tmpfiles.d/infinite.conf", `/etc/tmpfiles.d/infinite-${name}.conf`);
  text = text.replace(/\/etc\/infinite\//g, `/etc/infinite-${name}/`);
  text = text.replaceAll("infinite-github-refresh.service", `infinite-${name}-github-refresh.service`);
  text = text.replaceAll("infinite-github-refresh.timer", `infinite-${name}-github-refresh.timer`);
  text = text.replaceAll("infinite-host", `infinite-${name}-host`);
  text = text.replaceAll("infinite-agent", `infinite-${name}-agent`);
  text = text.replaceAll("infinite-workspace", `infinite-${name}-workspace`);

  return text;
}

function renderTemplate(filename, name) {
  const source = readFileSync(join(root, "deploy/ubuntu", filename), "utf8");
  if (!name) return source;

  let text = instanceText(source, name);
  if (filename === "infinite.service") {
    text = text.replace(/^Description=(.*)$/m, `Description=$1 (instance ${name})`);
    text = text.replace(/^(?:MemoryHigh|MemoryMax|CPUQuota)=.*\n/gm, "");
    text = text.replace(/^TasksMax=.*$/m, "TasksMax=infinity\nCPUWeight=50\nIOWeight=50\nOOMScoreAdjust=500");
  }
  if (filename === "agent-wrapper.sh")
    text = text.replace("export PATH=/usr/local/bin:/usr/bin:/bin", `export PATH=/usr/local/libexec/infinite-${name}/bin:/usr/local/bin:/usr/bin:/bin`);
  if (filename === "config.example.json") {
    const config = JSON.parse(text);
    delete config.maxSessions;
    config.port = port;
    config.origin = `https://infinite-${name}.YOUR-TAILNET.ts.net`;
    config.teams = {
      workspaceDir: `/srv/infinite-data/instances/${name}/team-workspaces`,
      commandPrefix: { command: `/usr/local/libexec/infinite-${name}/team-command`, args: [] },
    };
    config.hostLoad = { minAvailableMemoryGiB: 8, maxLoadPerCpu: 1.5 };
    text = `${JSON.stringify(config, null, 2)}\n`;
  }
  return text;
}

const outputDirectory = resolve(out);
mkdirSync(outputDirectory, { recursive: true });
if (realpathSync(outputDirectory) === realpathSync(join(root, "deploy/ubuntu")))
  fail("Output directory must not be deploy/ubuntu.");
for (const [source, destinationFor] of templates) {
  const destination = destinationFor(instance);
  const target = join(outputDirectory, destination);
  try {
    if (lstatSync(target).isSymbolicLink()) fail(`Output file must not be a symlink: ${destination}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!instance) copyFileSync(join(root, "deploy/ubuntu", source), target);
  else writeFileSync(target, renderTemplate(source, instance));
}
