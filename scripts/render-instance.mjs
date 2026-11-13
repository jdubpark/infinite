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
  ["transcript-drain.sh", () => "transcript-drain.sh"],
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

  const rules = [
    { pattern: /\/srv\/infinite-data\//, token: "/srv/infinite-data/", replacement: `/srv/infinite-data/instances/${name}/` },
    { pattern: /\/opt\/infinite-agents\/v1/, token: "/opt/infinite-agents/v1", replacement: `/srv/infinite-data/instances/${name}/agents/v1` },
    { pattern: /RuntimeDirectory=infinite-github(?=\s|$)/, token: "RuntimeDirectory=infinite-github", replacement: `RuntimeDirectory=infinite-${name}-github` },
    { pattern: /\/etc\/infinite-github(?=\/|$)/, token: "/etc/infinite-github", replacement: `/etc/infinite-${name}-github` },
    { pattern: /\/run\/infinite-github(?=\/|$)/, token: "/run/infinite-github", replacement: `/run/infinite-${name}-github` },
    { pattern: /\/run\/infinite-key\//, token: "/run/infinite-key/", replacement: `/run/infinite-${name}-key/` },
    { pattern: /RuntimeDirectory=infinite(?=\s|$)/, token: "RuntimeDirectory=infinite", replacement: `RuntimeDirectory=infinite-${name}` },
    { pattern: /\/usr\/local\/libexec\/infinite/, token: "/usr/local/libexec/infinite", replacement: `/usr/local/libexec/infinite-${name}` },
    { pattern: /\/etc\/sudoers\.d\/infinite/, token: "/etc/sudoers.d/infinite", replacement: `/etc/sudoers.d/infinite-${name}` },
    { pattern: /\/etc\/tmpfiles\.d\/infinite\.conf/, token: "/etc/tmpfiles.d/infinite.conf", replacement: `/etc/tmpfiles.d/infinite-${name}.conf` },
    { pattern: /\/etc\/infinite\//, token: "/etc/infinite/", replacement: `/etc/infinite-${name}/` },
    { pattern: /\/opt\/infinite(?=\/|[\s"']|$)/, token: "/opt/infinite", replacement: `/opt/infinite-${name}` },
    { pattern: /\/run\/infinite(?=\/|[\s"']|$)/, token: "/run/infinite", replacement: `/run/infinite-${name}` },
    { pattern: /infinite-github-refresh\.service/, token: "infinite-github-refresh.service", replacement: `infinite-${name}-github-refresh.service` },
    { pattern: /infinite-github-refresh\.timer/, token: "infinite-github-refresh.timer", replacement: `infinite-${name}-github-refresh.timer` },
    { pattern: /infinite-host/, token: "infinite-host", replacement: `infinite-${name}-host` },
    { pattern: /infinite-agent/, token: "infinite-agent", replacement: `infinite-${name}-agent` },
    { pattern: /infinite-workspace/, token: "infinite-workspace", replacement: `infinite-${name}-workspace` },
  ].sort((a, b) => b.token.length - a.token.length);
  const pattern = new RegExp(rules.map(rule => rule.pattern.source).join("|"), "g");
  const replacements = new Map(rules.map(({ token, replacement }) => [token, replacement]));
  // One pass over the original text keeps inserted instance paths from matching again.
  return source.replace(pattern, match => replacements.get(match) ?? match);
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
  if (filename === "infinite.sudoers") {
    // The briefing and code graph wrappers name the first instance's roots, so an instance permits neither.
    text = text.replace(`, /usr/local/libexec/infinite-${name}/jevcode *`, "");
    text = text.replace(/^# Optional code graph extraction.*\n.*\/repository-graph \*\n/m,
      "# Repository briefings and the code graph need instance wrappers; until they exist, this instance permits neither.\n");
    if (/jevcode|repository-graph/.test(text)) fail("The instance sudoers still permits jevcode or repository-graph.");
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
