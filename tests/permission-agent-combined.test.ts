import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { PermissionJournal, permissionJournalModule } from "../packages/host/src/evidence/permission-journal.js";
import { PermissionDelegationService } from "../packages/host/src/permission-delegation.js";
import { createPermissionAgentCore } from "../packages/host/src/permission-core.js";
import { HostPermissionPipeline, openPermissionPipelineState } from "../packages/host/src/permission-pipeline.js";
import { EvidenceDeliveryLedger, InteractivePermissionDelivery, permissionDeliveryModule } from "../packages/host/src/permission-delivery.js";
import { requesterNotice } from "../packages/host/src/permission-policy.js";
import type { PermissionTurn, PermissionTurnLauncher } from "../packages/host/src/permission-reviewer.js";
import type { PermissionInteractiveTarget, PermissionRequest } from "../packages/host/src/permission-agent-types.js";
import type { ProjectGroup, ProjectGroupList } from "../packages/host/src/project-group-types.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";
import type { Config, Project } from "../packages/host/src/types.js";

const ROOT = "/home/dev/projects/sample";
const light: TeamModelProfile = { id: "light", label: "Light", provider: "claude", model: "haiku", effort: "low" };
const strongClaude: TeamModelProfile = { id: "strong-claude", label: "Strong Claude", provider: "claude", model: "opus", effort: "high" };
const strongDeepSeek: TeamModelProfile = { id: "strong-deepseek", label: "Strong DeepSeek", provider: "opencode", model: "deepseek/deepseek-pro" };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "permission-combined-"));
  const projects: Project[] = [{ id: "sample", name: "Sample", path: join(root, "sample") }];
  const config = { stateDir: join(root, "state"), projects } as Config;
  const key = randomBytes(32);
  const group: ProjectGroup = {
    id: "workspace-one", name: "Workspace", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    repos: [{ projectId: "sample", name: "Sample", path: "project-root", checkouts: [{ projectId: "sample", name: "Sample", path: "project-root", primary: true, teamReady: false }] }],
  };
  const groups = {
    ownerMoveMark: () => "moves:0", storedHolder: () => group.id, containing: () => ({ id: group.id, name: group.name }),
    list: (): ProjectGroupList => ({ groups: [group], suggestions: [] }),
  };
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(config.stateDir), vaultKey: key });
  store.register(permissionJournalModule);
  store.register(permissionDeliveryModule);
  const journal = new PermissionJournal(store);
  const state = openPermissionPipelineState(store);
  assert.ok(state);
  const delegation = new PermissionDelegationService(config, key, groups as never);

  const turns: PermissionTurn[] = [];
  const reports: { light: unknown; strong: unknown } = { light: { verdict: "refer", note: "not routine" }, strong: { verdict: "reject", code: "uncertain", note: "undecided" } };
  const launcher: PermissionTurnLauncher = {
    supports: profile => profile.provider !== "codex",
    async run(turn) {
      turns.push(turn);
      return { ok: true, output: reports[turn.tier], startedAt: "2026-11-14T10:00:00.000Z", endedAt: "2026-11-14T10:00:01.000Z" };
    },
  };
  const settings = { light, strong: [strongClaude, strongDeepSeek], maxMissRate: 0.05, minCases: 100 };
  const core = createPermissionAgentCore({
    settings, launcher,
    results: { latest: binding => ({ id: "replay-1", binding, finishedAt: "2026-11-14T09:00:00.000Z", cases: 120, missRate: { count: 0, relevant: 90, rate: 0, lower: 0, upper: 0.04 } }) },
  });
  const pipeline = new HostPermissionPipeline({ core, journal, delegation, state });
  const delivery = new InteractivePermissionDelivery({ pipeline: () => pipeline, ledger: new EvidenceDeliveryLedger(store) });

  let seq = 0;
  const dialog = (command: string, destructive = false) => {
    seq++;
    const request: PermissionRequest = {
      id: `team:session-1:${seq}`,
      requester: { kind: "team-member", sessionId: "session-1", projectId: "sample", taskId: "run-1", assignment: "team:run-1:implementer:task:a",
        role: "implementer", provider: "codex", model: "gpt-5.5", sessionRoot: ROOT, scratchRoots: [], task: { title: "Fix the form", text: "Fix the postcode field and run its checks." } },
      tool: "Bash", input: { command }, action: command,
      prompt: { id: seq, kind: "permission", title: "Run this command?", detail: `$ ${command}`, acceptsText: true, source: "hook", hash: "a".repeat(64),
        options: [{ index: 0, label: "Yes", role: "accept" }, { index: 1, label: "No, and say why", role: "reject-with-feedback" }] },
      ...(destructive ? { destructive: { pattern: "rm -rf" } } : {}),
      shape: { completeEvidence: true, oneShotAccept: true, oneShotReject: true, persistentOnly: false, trustPrompt: false },
      evidenceHash: `evidence:${seq}`, reuseKey: `reuse:${command}`,
    };
    const answers: Array<{ option: number; notice?: string }> = [];
    const target: PermissionInteractiveTarget = {
      request,
      check: async () => ({ ok: true, accept: 0, reject: 1 }),
      answer: async (option, _decisionId, notice) => { answers.push({ option, ...(notice ? { notice } : {}) }); return "delivered"; },
    };
    return { target, answers };
  };
  return { core, pipeline, delivery, journal, delegation, turns, reports, dialog, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("the real core, pipeline, journal and delivery decide and deliver together", async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.core.readiness(), { ready: true, reasons: [] });

    const before = f.dialog("npm test");
    assert.equal((await f.delivery.handle(before.target)).handled, false);
    assert.deepEqual([f.turns.length, f.journal.decisions().length, before.answers.length], [0, 0, 0]);

    f.delegation.delegate("workspace-one", { requestId: randomUUID() }, { deviceId: "owner-device" });

    f.reports.light = { verdict: "allow", note: "a routine check" };
    const routine = f.dialog("npm test");
    const allowed = await f.delivery.handle(routine.target);
    assert.deepEqual([allowed.handled, allowed.handled && allowed.result], [true, "allowed"]);
    assert.deepEqual(routine.answers, [{ option: 0 }]);
    assert.deepEqual(f.turns.map(turn => turn.tier), ["light"]);
    const [allow] = f.journal.decisions({ verdict: "allow" });
    assert.deepEqual([allow.tiers.map(tier => tier.tier), allow.rules], [["light"], []]);
    assert.deepEqual(f.journal.deliveries(allow.id).map(event => event.kind), ["intent", "receipt"]);

    const credential = f.dialog("cat ~/.ssh/id_ed25519");
    const owner = await f.delivery.handle(credential.target);
    assert.deepEqual([owner.handled && owner.result, owner.handled && owner.interruptClass], ["owner", "credentials"]);
    assert.equal(f.turns.length, 1, "a class rule decides without a model turn");
    assert.equal(credential.answers.length, 0);
    assert.deepEqual(f.journal.decisions({ verdict: "owner" })[0].rules, ["class:credential-store"]);
    assert.equal(f.delivery.holder("session-1", credential.target.request.prompt!.id), "owner");

    f.reports.strong = { verdict: "reject", code: "outside-workspace", note: "The model's own words, for the owner only." };
    const outside = f.dialog("cat /var/log/system.log");
    const rejected = await f.delivery.handle(outside.target);
    assert.deepEqual([rejected.handled && rejected.result, rejected.handled && rejected.code], ["rejected", "outside-workspace"]);
    assert.deepEqual(f.turns.slice(1).map(turn => [turn.tier, turn.profile.id]), [["strong", "strong-claude"]]);
    assert.deepEqual(outside.answers, [{ option: 1, notice: requesterNotice("outside-workspace") }]);
    const [reject] = f.journal.decisions({ verdict: "reject" });
    assert.equal(reject.note, "The model's own words, for the owner only.");
    assert.ok(reject.rules.includes("raise:outside-root"));

    const again = f.dialog("cat /var/log/system.log");
    const replayed = await f.delivery.handle(again.target);
    assert.deepEqual([replayed.handled && replayed.result, f.turns.length], ["rejected", 2]);

    f.reports.strong = { verdict: "allow", noInterruptClass: true, note: "removes the build output" };
    const destructive = f.dialog("rm -rf dist", true);
    const strong = await f.delivery.handle(destructive.target);
    assert.deepEqual([strong.handled && strong.result, destructive.answers], ["allowed", [{ option: 0 }]]);
    assert.deepEqual(f.turns.at(-1)!.tier, "strong");
  } finally { f.close(); }
});
