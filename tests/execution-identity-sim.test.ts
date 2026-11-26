import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attention } from "@infinite/attention";
import { readDecisionQueue } from "../packages/host/src/decision-queue-read.js";
import { installHostEgress } from "../packages/host/src/egress.js";
import { sessionRequestFingerprint } from "../packages/host/src/launch.js";
import { Manager, type CreateSession } from "../packages/host/src/manager.js";
import { Notifier } from "../packages/host/src/notifier.js";
import { PushStore } from "../packages/host/src/push.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import type { TeamAssignment } from "../packages/host/src/team-types.js";
import { isEvalSession, sessionExecutionIdentity, type Config, type ExecutionIdentity, type Session, type SessionPurpose } from "../packages/host/src/types.js";
import { stopSessionWorkers } from "./helpers.js";

type SimKind =
  | "work"
  | "replay"
  | "gate"
  | "duel-prod"
  | "duel-eval"
  | "legacy-replay"
  | "legacy-gate"
  | "legacy-duel-eval"
  | "legacy-work";

type Fault =
  | "leak-eval-to-public"
  | "allow-prod-duel-remove"
  | "reject-legacy-eval-retry"
  | "misroute-prod-duel-profile";

interface TrackedRecord {
  id: string;
  kind: SimKind;
  request: CreateSession;
  team: TeamAssignment;
  header: { purpose?: SessionPurpose; executionIdentity?: ExecutionIdentity };
  expectedIdentity: ExecutionIdentity;
  legacy: boolean;
  deleted: boolean;
  launched: boolean;
}

interface LaunchMark {
  id: string;
  label: "production" | "eval";
  proxyProject: string | null;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const att = (state: Attention["state"], promptId?: number): Attention => ({
  state,
  since: "2026-11-26T00:00:00.000Z",
  source: "hook",
  now: state === "needs-you" ? "Do you want to proceed?" : "Exited",
  prompt: promptId ? { id: promptId, kind: "permission", title: "Do you want to proceed?", options: [], acceptsText: false, source: "hook" } : undefined,
  lastActivityAt: "2026-11-26T00:00:00.000Z",
  hooks: "active",
  hookErrors: 0,
  sawTurnEnd: false,
});

function kindSpec(kind: SimKind): {
  header: { purpose?: SessionPurpose; executionIdentity?: ExecutionIdentity };
  legacyPurpose?: SessionPurpose;
  expectedIdentity: ExecutionIdentity;
  legacy: boolean;
} {
  switch (kind) {
    case "work": return { header: { purpose: "work", executionIdentity: "production" }, expectedIdentity: "production", legacy: false };
    case "replay": return { header: { purpose: "replay", executionIdentity: "eval" }, expectedIdentity: "eval", legacy: false };
    case "gate": return { header: { purpose: "gate", executionIdentity: "eval" }, expectedIdentity: "eval", legacy: false };
    case "duel-prod": return { header: { purpose: "duel", executionIdentity: "production" }, expectedIdentity: "production", legacy: false };
    case "duel-eval": return { header: { purpose: "duel", executionIdentity: "eval" }, expectedIdentity: "eval", legacy: false };
    case "legacy-replay": return { header: { purpose: "replay", executionIdentity: "eval" }, legacyPurpose: "replay", expectedIdentity: "eval", legacy: true };
    case "legacy-gate": return { header: { purpose: "gate", executionIdentity: "eval" }, legacyPurpose: "gate", expectedIdentity: "eval", legacy: true };
    case "legacy-duel-eval": return { header: { purpose: "duel", executionIdentity: "eval" }, legacyPurpose: "duel", expectedIdentity: "eval", legacy: true };
    case "legacy-work": return { header: { purpose: "work", executionIdentity: "production" }, legacyPurpose: "work", expectedIdentity: "production", legacy: true };
  }
}

async function waitForCondition(check: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for simulator condition");
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

async function runSimulation(options: { seed: number; steps: number; fault?: Fault }) {
  const { seed, steps, fault } = options;
  const rand = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "exec-id-sim-")));
  const project = join(root, "project");
  const workspaceDir = join(root, "teams");
  const cwd = join(workspaceDir, "run");
  const stateDir = join(root, "state");
  const runDir = join(root, "run");
  const socketDir = mkdtempSync(join(tmpdir(), "eis-"));
  const pushDir = join(root, "push");
  const marksFile = join(root, "marks.jsonl");
  const egressKeyPath = join(root, "egress.key");
  for (const dir of [project, cwd, stateDir, runDir, pushDir]) mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  const keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  writeFileSync(egressKeyPath, randomBytes(32), { mode: 0o600 });
  const agent = join(root, "agent.mjs");
  writeFileSync(agent, [
    "import { appendFileSync } from \"node:fs\";",
    "const proxy = process.env.HTTPS_PROXY;",
    "let proxyProject = null, id = null;",
    "if (proxy) { try { const parts = decodeURIComponent(new URL(proxy).username).split(\".\"); proxyProject = parts[0] ?? null; id = parts[1] ?? null; } catch {} }",
    "appendFileSync(process.argv[2], JSON.stringify({ id, label: process.argv[3], proxyProject }) + \"\\n\");",
  ].join("\n") + "\n");
  const profile = (label: "production" | "eval") => ({ command: process.execPath, args: [agent, marksFile, label] });
  const config = {
    port: 0,
    origin: "http://127.0.0.1",
    keyFile,
    stateDir,
    runDir,
    socketDir,
    environment: "local",
    enableDemo: false,
    maxSessions: 32,
    agents: { claude: profile(fault === "misroute-prod-duel-profile" ? "eval" : "production") },
    projects: [{ id: "fixture", name: "Fixture", path: project }],
    teams: { workspaceDir },
    tokens: [],
    autonomy: { boundary: { egress: { proxyUrl: "http://127.0.0.1:4199", keyPath: egressKeyPath } } },
    attention: { hooks: { claude: false, codex: false }, idleAfterMs: 3000, limitConfirmMs: 30000 },
    eval: { member: { prefix: { command: "true", args: [] }, root, agents: { claude: profile("eval") } } },
  } as unknown as Config;

  installHostEgress(config);
  let manager = new Manager(config, key);
  const pushStore = new PushStore(pushDir, key);
  pushStore.add("controller", "ExponentPushToken[sim]", "android");
  const records = new Map<string, TrackedRecord>();
  const readMarks = (): LaunchMark[] => existsSync(marksFile)
    ? readFileSync(marksFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as LaunchMark)
    : [];

  const fail = (invariant: string, step: number, detail: string): never => {
    throw new Error(`[${invariant}] seed=${seed} step=${step}: ${detail}`);
  };

  const launchReal = async (kind: Extract<SimKind, "work" | "replay" | "gate" | "duel-prod" | "duel-eval">, step: number) => {
    const id = randomUUID();
    const spec = kindSpec(kind);
    const request: CreateSession = { requestId: id, provider: "claude", projectId: "fixture", title: `${kind}-${step}`, prompt: `run-${id}` };
    const team: TeamAssignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: kind === "duel-eval" ? "judge" : "implementer" };
    const beforeMarks = readMarks().length;
    await manager.createTeamSession(request, team, cwd, undefined, workspaceDir, true, spec.header);
    await waitForCondition(() => readMarks().length > beforeMarks);
    await waitForCondition(async () => {
      const state = await manager.state(id);
      return state.status === "exited" && !existsSync(join(socketDir, `${id}.sock`)) && !existsSync(join(runDir, `${id}.sock`));
    });
    if (fault === "allow-prod-duel-remove" && kind === "duel-prod") {
      const metaPath = join(stateDir, "sessions", id, "meta.sealed");
      const stored = unseal<{ session: Session; fingerprint: string }>(key, `${id}:meta`, readFileSync(metaPath, "utf8"));
      const { executionIdentity: _drop, ...broken } = stored.session;
      writeSealed(metaPath, key, `${id}:meta`, { session: broken, fingerprint: stored.fingerprint });
      manager = new Manager(config, key);
    }
    records.set(id, { id, kind, request, team, header: spec.header, expectedIdentity: spec.expectedIdentity, legacy: false, deleted: false, launched: true });
  };

  const seedLegacy = (kind: Extract<SimKind, "legacy-replay" | "legacy-gate" | "legacy-duel-eval" | "legacy-work">, step: number) => {
    const id = randomUUID();
    const spec = kindSpec(kind);
    const request: CreateSession = { requestId: id, provider: "claude", projectId: "fixture", title: `${kind}-${step}`, prompt: `legacy-${id}` };
    const team: TeamAssignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: kind === "legacy-duel-eval" ? "judge" : "implementer" };
    const legacyPayload = {
      ...request,
      team,
      teamCwd: cwd,
      ...(spec.legacyPurpose !== undefined ? { purpose: spec.legacyPurpose } : {}),
    };
    const fingerprint = fault === "reject-legacy-eval-retry" && spec.expectedIdentity === "eval"
      ? sessionRequestFingerprint({ ...legacyPayload, prompt: "tampered" }, id)
      : sessionRequestFingerprint(legacyPayload, id);
    const dir = join(stateDir, "sessions", id);
    mkdirSync(dir, { recursive: true });
    writeSealed(join(dir, "meta.sealed"), key, `${id}:meta`, {
      session: {
        id,
        team,
        ...(spec.legacyPurpose !== undefined ? { purpose: spec.legacyPurpose } : {}),
        provider: "claude",
        title: request.title,
        projectId: "fixture",
        cwd,
        createdAt: "2026-11-26T00:00:00.000Z",
        status: "exited",
        contextVersion: 0,
        context: "",
        initialPrompt: request.prompt,
      },
      fingerprint,
    });
    writeSealed(join(dir, "status.sealed"), key, `${id}:status`, {
      status: "exited",
      seq: 1,
      screen: "",
      attention: att("exited"),
    });
    records.set(id, { id, kind, request, team, header: spec.header, expectedIdentity: spec.expectedIdentity, legacy: true, deleted: false, launched: false });
  };

  const checkInvariants = async (step: number) => {
    const listed = await manager.list();
    const byId = new Map(listed.map(row => [row.id, row]));
    const publicFilter = fault === "leak-eval-to-public"
      ? (row: { purpose?: SessionPurpose }) => row.purpose !== "replay"
      : (row: { executionIdentity?: ExecutionIdentity; purpose?: SessionPurpose }) => !isEvalSession(row);
    const publicIds = new Set(listed.filter(publicFilter).map(row => row.id));

    const probeRows = [...records.values()]
      .filter(record => !record.deleted)
      .map((record, index) => {
        const listedRow = byId.get(record.id);
        return {
          id: record.id,
          title: record.request.title,
          provider: "claude" as const,
          projectId: "fixture",
          status: "running" as const,
          purpose: listedRow?.purpose,
          executionIdentity: listedRow?.executionIdentity,
          attention: att("needs-you", index + 1),
        };
      });
    const probeManager = { list: async () => probeRows } as never;
    const queue = await readDecisionQueue({
      manager: probeManager,
      cmux: undefined,
      permissions: { holder: () => "owner" },
      teams: { decisionQueueCandidates: () => [], decisionQueueSessionOrigin: () => undefined, promptOwner: () => "user" },
      goals: { decisionAnswerable: () => false },
      missions: { decisionQueueCandidates: () => [] },
    });
    const queuedIds = new Set(queue.decisions.map(item => item.origin.id));

    const sentUrls: string[] = [];
    const notifier = new Notifier(
      { list: async () => probeRows.map(row => ({ ...row, attention: att("working") })) } as never,
      pushStore,
      async messages => messages.map(() => ({ status: "ok" as const, id: "p" })),
      { detail: "minimal", events: ["needs-you"], intervalMs: 100000 },
    );
    await notifier.tick();
    (notifier as unknown as { manager: unknown }).manager = probeManager;
    (notifier as unknown as { sender: (messages: { data: { url: string } }[]) => Promise<unknown[]> }).sender = async messages => {
      sentUrls.push(...messages.map(message => message.data.url));
      return messages.map(() => ({ status: "ok" as const, id: "p" }));
    };
    await notifier.tick();
    const notifiedIds = new Set(sentUrls.map(url => url.replace("/session/", "")));

    for (const record of records.values()) {
      if (record.deleted) {
        if (byId.has(record.id)) fail("I3_IDENTITY_IMMUTABLE_ON_RETRY_AND_RESTART", step, `deleted session ${record.id} still listed`);
        continue;
      }
      const listedRow = byId.get(record.id);
      if (!listedRow) fail("I3_IDENTITY_IMMUTABLE_ON_RETRY_AND_RESTART", step, `session ${record.id} (${record.kind}) missing from manager.list()`);
      const persisted = manager.meta(record.id).session;
      const effectiveIdentity = sessionExecutionIdentity(persisted);

      if (record.expectedIdentity === "eval") {
        if (publicIds.has(record.id) || queuedIds.has(record.id) || notifiedIds.has(record.id)) {
          fail("I1_NO_EVAL_LEAK", step, `eval session ${record.id} (${record.kind}) leaked to public/queue/notifier`);
        }
        if (effectiveIdentity !== "eval") {
          fail("I3_IDENTITY_IMMUTABLE_ON_RETRY_AND_RESTART", step, `eval session ${record.id} resolved to ${effectiveIdentity}`);
        }
      } else {
        if (!publicIds.has(record.id) || !queuedIds.has(record.id) || !notifiedIds.has(record.id)) {
          fail("I2_PROD_DUEL_VISIBLE_AND_PROTECTED", step, `production session ${record.id} (${record.kind}) hidden from public/queue/notifier`);
        }
        if (effectiveIdentity !== "production") {
          fail("I2_PROD_DUEL_VISIBLE_AND_PROTECTED", step, `production session ${record.id} (${record.kind}) resolved to ${effectiveIdentity}`);
        }
      }
    }

    const marksById = new Map(readMarks().map(mark => [mark.id, mark]));
    for (const record of records.values()) {
      if (!record.launched) continue;
      const mark = marksById.get(record.id);
      if (!mark) fail("I4_EVAL_AGENT_BOUNDARY", step, `missing launch mark for ${record.kind} (${record.id})`);
      const expectedProxy = record.expectedIdentity === "eval" ? "_eval" : "fixture";
      if (mark.label !== record.expectedIdentity || mark.proxyProject !== expectedProxy) {
        fail("I4_EVAL_AGENT_BOUNDARY", step, `${record.kind} ran with label=${mark.label} proxy=${mark.proxyProject} (expected ${record.expectedIdentity}/${expectedProxy})`);
      }
    }
  };

  try {
    const initialKinds: readonly Extract<SimKind, "work" | "replay" | "gate" | "duel-prod" | "duel-eval">[] = ["work", "replay", "gate", "duel-prod", "duel-eval"];
    const legacyKinds: readonly Extract<SimKind, "legacy-replay" | "legacy-gate" | "legacy-duel-eval" | "legacy-work">[] = ["legacy-replay", "legacy-gate", "legacy-duel-eval", "legacy-work"];
    for (let i = 0; i < initialKinds.length; i++) {
      await launchReal(initialKinds[i]!, i);
      await checkInvariants(i);
    }
    for (let i = 0; i < legacyKinds.length; i++) {
      seedLegacy(legacyKinds[i]!, initialKinds.length + i);
      await checkInvariants(initialKinds.length + i);
    }

    for (let step = initialKinds.length + legacyKinds.length; step < steps; step++) {
      const op = pick(["restart", "retry-same", "retry-same", "retry-cross-duel", "remove", "seed-legacy"] as const);
      const all = [...records.values()];
      if (op === "restart") {
        manager = new Manager(config, key);
      } else if (op === "seed-legacy" && all.length < 18) {
        seedLegacy(pick(legacyKinds), step);
      } else if (op === "retry-same") {
        const target = pick(all);
        if (target.deleted) {
          let err: unknown;
          try {
            await manager.createTeamSession(target.request, target.team, cwd, undefined, workspaceDir, true, target.header);
          } catch (caught) {
            err = caught;
          }
          if (!(err instanceof Error && (err as { status?: number }).status === 410)) {
            fail("I3_IDENTITY_IMMUTABLE_ON_RETRY_AND_RESTART", step, `retry of deleted ${target.kind} returned ${String(err)} instead of 410`);
          }
        } else {
          let retried: Session;
          try {
            retried = await manager.createTeamSession(target.request, target.team, cwd, undefined, workspaceDir, true, target.header);
          } catch (caught) {
            fail("I3_IDENTITY_IMMUTABLE_ON_RETRY_AND_RESTART", step, `idempotent retry of ${target.kind} failed: ${String(caught)}`);
          }
          if (retried!.id !== target.id || sessionExecutionIdentity(retried!) !== target.expectedIdentity) {
            fail("I3_IDENTITY_IMMUTABLE_ON_RETRY_AND_RESTART", step, `retry of ${target.kind} returned mismatched id or identity`);
          }
        }
      } else if (op === "retry-cross-duel") {
        const duels = all.filter(item => item.header.purpose === "duel");
        const target = pick(duels);
        const opposite: ExecutionIdentity = target.expectedIdentity === "eval" ? "production" : "eval";
        let err: unknown;
        try {
          await manager.createTeamSession(target.request, target.team, cwd, undefined, workspaceDir, true, { purpose: "duel", executionIdentity: opposite });
        } catch (caught) {
          err = caught;
        }
        if (!(err instanceof Error && /Request ID already belongs to a different session/.test(err.message))) {
          fail("I3_IDENTITY_IMMUTABLE_ON_RETRY_AND_RESTART", step, `cross-identity duel retry on ${target.kind} was not refused: ${String(err)}`);
        }
      } else if (op === "remove") {
        const candidates = all.filter(item => !item.deleted);
        if (candidates.length > 0) {
          const target = pick(candidates);
          if (target.expectedIdentity === "production") {
            let err: unknown;
            try {
              await manager.remove(target.id);
            } catch (caught) {
              err = caught;
            }
            if (!(err instanceof Error && (err as { status?: number }).status === 409)) {
              fail("I2_PROD_DUEL_VISIBLE_AND_PROTECTED", step, `production team session ${target.kind} was removed or returned non-409: ${String(err)}`);
            }
          } else {
            await manager.remove(target.id);
            target.deleted = true;
          }
        }
      }
      await checkInvariants(step);
    }
  } finally {
    installHostEgress({});
    await stopSessionWorkers(config);
    await new Promise(resolve => setTimeout(resolve, 400));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(socketDir, { recursive: true, force: true });
  }
}

test("seeded durable-state simulator holds execution-identity invariants across restarts, retries, and removals", { timeout: 120_000 }, async t => {
  const seed = Number(process.env.INFINITE_SIM_SEED ?? 20261126);
  t.diagnostic(`execution-identity simulator seed=${seed}`);
  await runSimulation({ seed, steps: 60 });
});

test("targeted mutations fail each named execution-identity simulator invariant", { timeout: 180_000 }, async t => {
  const cases: readonly [Fault, string][] = [
    ["leak-eval-to-public", "I1_NO_EVAL_LEAK"],
    ["allow-prod-duel-remove", "I2_PROD_DUEL_VISIBLE_AND_PROTECTED"],
    ["reject-legacy-eval-retry", "I3_IDENTITY_IMMUTABLE_ON_RETRY_AND_RESTART"],
    ["misroute-prod-duel-profile", "I4_EVAL_AGENT_BOUNDARY"],
  ];
  for (const [fault, invariant] of cases) {
    t.diagnostic(`mutation fault=${fault} expected=${invariant}`);
    await assert.rejects(
      () => runSimulation({ seed: 20261126, steps: 40, fault }),
      (error: unknown) => error instanceof Error && error.message.includes(`[${invariant}]`),
      `fault ${fault} must trip ${invariant}`,
    );
  }
});
