import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Manager } from "../packages/host/src/manager.js";
import { HeadlessPermissionChannel } from "../packages/host/src/permission-headless.js";
import type { PermissionAgentServices, PermissionOutcome, PermissionPipeline, PermissionRequest } from "../packages/host/src/permission-agent-types.js";
import type { Config, Session } from "../packages/host/src/types.js";
import { stopSessionWorkers } from "./helpers.js";

const FAKE = resolve("tests/fixtures/headless-claude.mjs");

export function fakePipeline(overrides: Partial<PermissionPipeline> = {}) {
  const deliveries: Array<{ decisionId: string; kind: string; detail?: string }> = [];
  const decided: PermissionRequest[] = [];
  const classOf = (request: PermissionRequest) =>
    /production/.test(request.action) ? { interruptClass: "production-or-staging" as const, rule: "production-deploy" } : undefined;
  const pipeline: PermissionPipeline = {
    serves: () => ({ served: true }),
    classOf,
    async decide(request): Promise<PermissionOutcome> {
      decided.push(request);
      const decisionId = randomUUID();
      const match = classOf(request);
      if (match) return { kind: "owner", decisionId, interruptClass: match.interruptClass };
      if (/safe-build/.test(request.action)) return { kind: "allow", decisionId, strongTier: false };
      return { kind: "reject", decisionId, code: "unsafe", notice: "MODEL TEXT that must never reach the agent" };
    },
    applicable: () => true,
    recordDelivery: (decisionId, kind, detail) => { deliveries.push({ decisionId, kind, ...(detail ? { detail } : {}) }); },
    taskEnded() {},
    ...overrides,
  };
  return { pipeline, deliveries, decided };
}

export async function rig(options: { args?: string[]; pipeline?: PermissionPipeline; overrides?: Partial<PermissionPipeline> } = {}) {
  const root = realpathSync(mkdtempSync("/tmp/inf-headless-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const key = randomBytes(32);
  const keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const config: Config = {
    port: 0, origin: "http://127.0.0.1", keyFile, stateDir: join(root, "state"), runDir: join(root, "run"),
    environment: "local", enableDemo: false, maxSessions: 8,
    agents: { claude: { command: process.execPath, args: [FAKE, "--print", ...(options.args ?? [])] } },
    projects: [{ id: "rehearsal", name: "Rehearsal", path: workspace }],
    tokens: [],
    attention: { hooks: { claude: true, codex: false }, idleAfterMs: 3000, limitConfirmMs: 30000 },
  } as Config;
  const manager = new Manager(config, key);
  const fake = fakePipeline(options.overrides);
  const services: PermissionAgentServices = { pipeline: options.pipeline ?? fake.pipeline };
  const channel = new HeadlessPermissionChannel({ key, runDir: config.runDir, sessions: manager, services });
  manager.useHeadlessChannel(channel);
  await channel.listen();
  return {
    root, workspace, config, key, manager, channel, services, ...fake,
    log: (name: string) => existsSync(join(workspace, name)) ? readFileSync(join(workspace, name), "utf8") : "",
    channelEvents: (id: string) => manager.events(id, 0, 500, new Set(["lifecycle"])).events
      .map(event => (event.data as { permissionChannel?: Record<string, unknown> }).permissionChannel).filter(Boolean) as Array<Record<string, unknown>>,
    stop: async () => {
      await stopSessionWorkers(config);
      channel.close();
      await new Promise(done => setTimeout(done, 1700));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type Live = Session & { status: string; attention: { state: string; prompt?: { id: number; source: string; options: Array<{ label: string }> } }; permissionChannel?: { served: boolean; waiting?: { interruptClass: string; tool: string }; notice?: { id: string; interruptClass?: string } } };
export const live = async (r: Awaited<ReturnType<typeof rig>>, id: string) => ({ ...r.manager.meta(id).session, ...(await r.manager.state(id)) }) as unknown as Live;
