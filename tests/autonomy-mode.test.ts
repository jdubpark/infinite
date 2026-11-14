import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autonomyOf, enrollmentAutonomy } from "../packages/host/src/autonomy.js";
import { readConfig } from "../packages/host/src/config.js";
import { RoutineService } from "../packages/host/src/routines.js";
import type { CreateRoutine } from "../packages/host/src/routine-types.js";
import type { Config, Project } from "../packages/host/src/types.js";
import { unseal } from "../packages/host/src/vault.js";

const lineup = {
  coordinator: { id: "coord", label: "Coordinator", provider: "claude", model: "model", effort: "high", tier: "strong" },
  implementers: [{ id: "haiku", label: "Haiku", provider: "claude", model: "claude-haiku-5-5", effort: "low", tier: "light" }],
  escalations: [{ id: "sonnet", label: "Sonnet", provider: "claude", model: "claude-sonnet-5-5", effort: "high", tier: "strong" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "model", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "model", effort: "high", tier: "strong" },
};

test("a missing or unknown pin reads as supervised", () => {
  assert.equal(autonomyOf(undefined), "supervised");
  assert.equal(autonomyOf({}), "supervised");
  assert.equal(autonomyOf({ autonomy: null }), "supervised");
  assert.equal(autonomyOf({ autonomy: "auto" }), "supervised");
  assert.equal(autonomyOf({ autonomy: "Autonomous" }), "supervised");
  assert.equal(autonomyOf({ autonomy: "autonomous" }), "autonomous");
});

test("an enrollment reads its saved mode, then the host default, then autonomous", () => {
  assert.deepEqual(enrollmentAutonomy({}, {}), { mode: "autonomous", source: "host-default" });
  assert.deepEqual(enrollmentAutonomy({}, { autonomy: { defaultMode: "supervised" } }), { mode: "supervised", source: "host-default" });
  assert.deepEqual(enrollmentAutonomy({ autonomy: "supervised" }, { autonomy: { defaultMode: "autonomous" } }), { mode: "supervised", source: "saved" });
  assert.deepEqual(enrollmentAutonomy({ autonomy: "auto" }, {}), { mode: "supervised", source: "saved" });
});

// A copy of the digest formula that RoutineService.authority() applies today, before any mode existed.
function frozenAuthority(config: Config, project: Project) {
  const canonicalPath = realpathSync(project.path);
  return createHash("sha256").update(JSON.stringify({
    project: { path: canonicalPath, team: project.team, teamworkDir: project.teamworkDir, source: project.source, linear: project.linear },
    teams: config.teams, source: config.source, linear: config.linear, agents: config.agents,
  })).digest("hex");
}

const hostConfig = (root: string, extra: Record<string, unknown> = {}) => {
  const keyFile = join(root, "key"), linearKey = join(root, "linear-key");
  mkdirSync(join(root, "project"), { recursive: true });
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  writeFileSync(linearKey, "lin_api_example\n", { mode: 0o600 });
  return {
    port: 4780, origin: "http://127.0.0.1:4780", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile,
    environment: "local", tokens: [{ id: "owner", label: "Owner", role: "owner", hash: "a".repeat(64) }],
    linear: { apiKeyFile: linearKey },
    source: { mirrorDir: join(root, "mirrors") },
    teams: { workspaceDir: join(root, "teams"), commandPrefix: { command: "safe", args: [] }, lineup },
    agents: { claude: { command: "claude", args: [] }, codex: { command: "codex", args: [] } },
    projects: [{ id: "demo", name: "Demo", path: join(root, "project"), team: {
      checks: [{ command: "node", args: ["check.js"] }],
      delivery: { mode: "merge", repository: "example/demo", baseBranch: "main" },
      permissions: { mode: "coordinator", scope: "Routine approvals" },
    } }],
    ...extra,
  };
};

test("parsing the host configuration adds no key to a digested block", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "autonomy-config-")));
  try {
    const write = (name: string, value: unknown) => { const file = join(root, name); writeFileSync(file, JSON.stringify(value)); return file; };
    const plain = readConfig(write("plain.json", hostConfig(root))).config;
    const explicit = readConfig(write("explicit.json", hostConfig(root, { autonomy: { defaultMode: "supervised" } }))).config;
    const digested = (config: Config) => JSON.stringify({ teams: config.teams, source: config.source, linear: config.linear, agents: config.agents, team: config.projects[0]!.team });
    // Frozen from today's parse: schema defaults (publishHeads, mergeMethod, maxDecisions) are part of the digest and stay unchanged.
    const frozen = '{"teams":{"workspaceDir":"ROOT/teams","commandPrefix":{"command":"safe","args":[]},"lineup":{"coordinator":{"id":"coord","label":"Coordinator","provider":"claude","model":"model","effort":"high","tier":"strong"},"integrator":{"id":"integrator","label":"Integrator","provider":"claude","model":"model","effort":"high","tier":"strong"},"reviewer":{"id":"reviewer","label":"Reviewer","provider":"claude","model":"model","effort":"high","tier":"strong"},"implementers":[{"id":"haiku","label":"Haiku","provider":"claude","model":"claude-haiku-5-5","effort":"low","tier":"light"}],"escalations":[{"id":"sonnet","label":"Sonnet","provider":"claude","model":"claude-sonnet-5-5","effort":"high","tier":"strong"}]},"publishHeads":true},"source":{"mirrorDir":"ROOT/mirrors"},"linear":{"apiKeyFile":"ROOT/linear-key"},"agents":{"claude":{"command":"claude","args":[]},"codex":{"command":"codex","args":[]}},"team":{"checks":[{"command":"node","args":["check.js"]}],"delivery":{"mode":"merge","repository":"example/demo","baseBranch":"main","mergeMethod":"squash"},"permissions":{"mode":"coordinator","scope":"Routine approvals","maxDecisions":25}}}'.replaceAll("ROOT", root);
    assert.equal(digested(plain), frozen);
    assert.equal(digested(explicit), digested(plain));
    assert.equal(Object.hasOwn(plain, "autonomy"), false);
    assert.deepEqual(explicit.autonomy, { defaultMode: "supervised" });
    assert.throws(() => readConfig(write("auto.json", hostConfig(root, { autonomy: { defaultMode: "auto" } }))));
    assert.throws(() => readConfig(write("mode-key.json", hostConfig(root, { autonomy: { mode: "supervised" } }))));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the routine authority digest is the same before and after modes exist", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "autonomy-digest-")));
  try {
    const stateDir = join(root, "state"); mkdirSync(stateDir);
    const file = join(root, "config.json");
    writeFileSync(file, JSON.stringify(hostConfig(root)));
    const { config, key } = readConfig(file);
    const project = config.projects[0]!;
    const hooks = { isProjectBusy: async () => false, startGoal: async () => { throw new Error("not due"); } };
    const create = (service: RoutineService) => service.create({
      requestId: randomUUID(),
      goal: { projectId: "demo", title: "Small task", objective: "Do the bounded work", successCriteria: "The requested change is available", allowedPaths: ["src"], maxRuns: 1, maxMinutes: 5, maxMembers: 4 },
      intervalMinutes: 5, maxOccurrences: 2,
      startsAt: new Date(Date.now() + 60 * 60_000).toISOString(), expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString(),
    } as CreateRoutine);
    const sealedAuthority = (id: string) => unseal<{ authority: string; routine: { status: string; reason?: string } }>(key, `routine:${id}`, readFileSync(join(stateDir, "routines", `${id}.sealed`), "utf8"));

    const first = new RoutineService({ ...config, stateDir }, key, {} as never, hooks);
    const routine = await create(first);
    first.close();
    const expected = frozenAuthority(config, project);
    assert.equal(sealedAuthority(routine.id).authority, expected);

    for (const pin of [{ project: "autonomous", defaultMode: "supervised" }, { project: "supervised", defaultMode: "supervised" }] as const) {
      (project as Project).autonomy = pin.project;
      (config as Config).autonomy = { defaultMode: pin.defaultMode };
      const restarted = new RoutineService({ ...config, stateDir }, key, {} as never, hooks);
      await restarted.tick();
      restarted.close();
      const sealed = sealedAuthority(routine.id);
      assert.equal(sealed.routine.status, "scheduled");
      assert.equal(sealed.routine.reason, undefined);
      assert.equal(sealed.authority, expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
