#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  unlinkSync,
  openSync,
  closeSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createApp } from "./server.js";
import { Notifier } from "./notifier.js";
import { expoSender } from "./push.js";
import { DEFAULT_HOOKS, readConfig, hashToken } from "./config.js";
import { workerCall } from "./ipc.js";
import { Manager } from "./manager.js";
import { parseDeployment } from "./deployment.js";
import { planFleet } from "./fleet.js";
import type { Config, Provider, Role } from "./types.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    "state-dir": { type: "string" },
    "key-file": { type: "string" },
    "run-dir": { type: "string" },
    origin: { type: "string" },
    project: { type: "string" },
    port: { type: "string" },
    provider: { type: "string" },
    title: { type: "string" },
    prompt: { type: "string" },
    "deployment-mode": { type: "string" },
    "tenant-id": { type: "string" },
  },
});
const command = positionals[0] ?? "help";
const dev = command === "dev";
const configFile = resolve(
  values.config ??
    process.env.INFINITE_CONFIG ??
    (dev
      ? ".local/config.json"
      : join(homedir(), ".config/infinite/config.json")),
);

function initialize() {
  const deployment = parseDeployment({
    mode: values["deployment-mode"] ?? "single-tenant",
    ...(values["tenant-id"] ? { tenantId: values["tenant-id"] } : {}),
  });
  const rehearsalOnly = deployment.mode === "tenant-development";
  if (existsSync(configFile))
    throw new Error(`Configuration already exists: ${configFile}`);
  const base = dirname(configFile);
  const keyFile = resolve(
    values["key-file"] ?? join(base, "secrets/vault.key"),
  );
  const stateDir = resolve(
    values["state-dir"] ??
      (dev ? ".local/data" : join(homedir(), ".local/share/infinite")),
  );
  const runDir = resolve(
    values["run-dir"] ??
      join(
        "/tmp",
        `inf-${process.getuid?.() ?? "user"}-${dev ? "dev" : "host"}`,
      ),
  );
  for (const dir of [base, dirname(keyFile), stateDir, runDir])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
  const devices = Object.fromEntries(
    (["owner", "controller", "viewer"] as Role[]).map((role) => [
      role,
      randomBytes(32).toString("base64url"),
    ]),
  );
  writeFileSync(join(base, "devices.json"), JSON.stringify(devices, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  const port = Number(values.port ?? 4780);
  const demoFile = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./demo.ts" : "./demo.js",
      import.meta.url,
    ),
  );
  const config: Config = {
    deployment,
    port,
    origin: values.origin ?? `http://127.0.0.1:${port}`,
    stateDir,
    runDir,
    keyFile,
    environment: dev ? "local" : "cloud",
    enableDemo: dev || rehearsalOnly,
    maxSessions: 24,
    tokens: Object.entries(devices).map(([role, token]) => ({
      id: randomUUID(),
      label: role,
      role: role as Role,
      hash: hashToken(token),
    })),
    projects: [
      {
        id: "workspace",
        name: dev ? "Continuity rehearsal" : "Workspace",
        path: resolve(
          values.project ?? (dev ? ".local/workspace" : process.cwd()),
        ),
      },
    ],
    agents: {
      ...(!rehearsalOnly
        ? {
            claude: { command: "claude", args: [] },
            codex: { command: "codex", args: [] },
            grok: { command: "grok", args: [] },
            opencode: { command: "opencode", args: [] },
          }
        : {}),
      ...(dev || rehearsalOnly
        ? {
            demo: {
              command: process.execPath,
              args: demoFile.endsWith(".ts")
                ? ["--import", import.meta.resolve("tsx"), demoFile]
                : [demoFile],
            },
          }
        : {}),
    },
  };
  mkdirSync(config.projects[0].path, { recursive: true, mode: 0o700 });
  writeFileSync(configFile, JSON.stringify(config, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    `Configuration: ${configFile}\nDevice keys: ${join(base, "devices.json")} (private file)\nKeep the vault key separate from state backups.`,
  );
}

async function attach(manager: Manager, sessionId: string) {
  if (!/^[a-f0-9-]{36}$/.test(sessionId))
    throw new Error("Provide a session UUID");
  const session = manager.meta(sessionId).session;
  console.error(
    `Attaching to ${session.title}. Ctrl+] detaches; Ctrl+C interrupts the agent.`,
  );
  let cursor = 0,
    busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      let page;
      do {
        page = manager.events(sessionId, cursor, 200);
        for (const event of page.events)
          if (event.type === "output")
            process.stdout.write(String(event.data.text));
        cursor = page.cursor;
      } while (page.more);
    } finally {
      busy = false;
    }
  };
  await poll();
  const timer = setInterval(() => {
    void poll().catch(() => cleanup());
  }, 200);
  const cleanup = () => {
    clearInterval(timer);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.exit(0);
  };
  let inputChain = Promise.resolve();
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.on("data", (data: string) => {
    if (data.includes("\x1d")) return cleanup();
    inputChain = inputChain
      .then(async () => {
        for (let offset = 0; offset < data.length; offset += 8192)
          await workerCall(manager.config.runDir, sessionId, {
            op: "raw",
            text: data.slice(offset, offset + 8192),
            requestId: randomUUID(),
          });
      })
      .catch(() =>
        console.error(
          "\r\nInput was not confirmed. Check the session before retrying.",
        ),
      );
  });
  process.on("SIGTERM", cleanup);
}

if (command === "help")
  console.log(`Infinite — persistent agent sessions

npm run dev                          Start a private local rehearsal
infinite init --origin https://HOST   Create host configuration and device keys
infinite init --deployment-mode single-tenant --origin https://HOST
infinite serve --config FILE          Start the API; workers survive API exit
infinite doctor --config FILE         Check configured CLI binaries
infinite list --config FILE           List sessions on this host
infinite new --provider codex --title "Task" --prompt "..."
infinite attach SESSION_ID --config FILE
infinite plan-fleet FILE               Print a secret-free development VM plan
infinite init --deployment-mode tenant-development --tenant-id UUID --origin https://HOST

Use SSH from a cmux terminal: ssh -t HOST 'infinite attach SESSION_ID'
Use the owner key only on your laptop. Pair phones with the controller key.`);
else if (command === "plan-fleet") {
  if (!positionals[1]) throw new Error("Provide a fleet JSON file");
  console.log(
    JSON.stringify(
      planFleet(JSON.parse(readFileSync(positionals[1], "utf8"))),
      null,
      2,
    ),
  );
} else if (command === "init") {
  if (!values.origin?.startsWith("https://"))
    throw new Error("init requires --origin https://your-host.tailnet.ts.net");
  initialize();
} else {
  if (dev && !existsSync(configFile)) initialize();
  const { config, key } = readConfig(configFile);
  if (command === "serve" || dev) {
    mkdirSync(config.runDir, { recursive: true, mode: 0o700 });
    const lock = join(config.runDir, "server.lock");
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) throw new Error("Another host API owns this run directory");
      unlinkSync(lock);
    }
    const fd = openSync(lock, "wx", 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    const { app, manager, pushStore } = createApp(config, key);
    const server = app.listen(config.port, "127.0.0.1", () =>
      console.log(
        `Infinite: ${config.origin}\nExecution host: ${config.environment}\nClosing this API does not stop agent workers.`,
      ),
    );
    if (config.push?.enabled) {
      const accessToken = config.push.accessTokenFile
        ? readFileSync(config.push.accessTokenFile, "utf8").trim()
        : undefined;
      new Notifier(
        manager,
        pushStore,
        expoSender({ endpoint: config.push.endpoint, accessToken }),
        {
          detail: config.push.detail,
          events: config.push.events,
          intervalMs: 2000,
        },
      ).start();
      console.log(`Push notifications: enabled (${config.push.detail} bodies)`);
    }
    const unlock = () => {
      try {
        unlinkSync(lock);
      } catch {}
    };
    server.on("error", (error) => {
      unlock();
      throw error;
    });
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      process.once(signal, () => {
        server.close(() => {
          unlock();
          process.exit(0);
        });
        server.closeAllConnections();
      });
  } else {
    const manager = new Manager(config, key);
    if (command === "list")
      for (const session of await manager.list())
        console.log(
          `${session.id}  ${session.provider.padEnd(8)}  ${session.status.padEnd(12)}  ${session.title}`,
        );
    else if (command === "new") {
      const provider = values.provider as Provider;
      if (!config.agents[provider])
        throw new Error("Choose a configured --provider");
      const session = await manager.create({
        requestId: randomUUID(),
        provider,
        projectId: values.project ?? config.projects[0].id,
        title: values.title ?? `${provider} session`,
        prompt: values.prompt ?? "",
      });
      console.log(`${session.id}  ${session.status}`);
    } else if (command === "attach") await attach(manager, positionals[1]);
    else if (command === "doctor") {
      for (const [provider, profile] of Object.entries(config.agents)) {
        if (provider === "demo" || !profile) continue;
        const hooks =
          provider === "claude" || provider === "codex"
            ? ` · hooks ${(config.attention?.hooks ?? DEFAULT_HOOKS)[provider] ? "enabled" : "disabled"}`
            : "";
        try {
          console.log(
            `${provider}: ${execFileSync(profile.command, [...profile.args, "--version"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim()}${hooks}`,
          );
        } catch {
          console.log(
            `${provider}: unavailable; install and authenticate on this host`,
          );
        }
      }
      const relay = join(dirname(fileURLToPath(import.meta.url)), "hook-relay.js");
      console.log(
        `Hook relay: ${existsSync(relay) ? relay : "MISSING (run npm run build)"}`,
      );
      const userSettings = join(homedir(), ".claude", "settings.json");
      if (existsSync(userSettings)) {
        try {
          const parsed = JSON.parse(readFileSync(userSettings, "utf8"));
          if (parsed.allowedHttpHookUrls)
            console.log(
              "WARNING: ~/.claude/settings.json defines allowedHttpHookUrls; add http://127.0.0.1:*/hook/claude or Infinite's Claude hooks will not run.",
            );
        } catch {
          /* unreadable settings are the user's concern */
        }
      }
      if (config.push?.enabled) {
        let mode = "missing";
        if (config.push.accessTokenFile) {
          try {
            mode = (statSync(config.push.accessTokenFile).mode & 0o777).toString(8);
          } catch {
            /* reported as missing */
          }
        }
        console.log(
          `Push: enabled · ${config.push.detail} bodies · token file ${config.push.accessTokenFile ?? "none"} (mode ${mode})`,
        );
      } else console.log("Push: disabled");
      if ((config.attention?.hooks ?? DEFAULT_HOOKS).codex)
        console.log(
          "Codex hooks use --dangerously-bypass-hook-trust for the hooks Infinite injects per process only (unverified until spike S2).",
        );
    } else throw new Error(`Unknown command: ${command}`);
  }
}
