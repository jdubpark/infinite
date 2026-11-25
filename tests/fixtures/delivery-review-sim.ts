import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { automaticMergeReviewReason, deliveryReviewLineageAtBase } from "../../packages/host/src/delivery-review.js";
import type { TeamMember, TeamModelProfile } from "../../packages/host/src/team-types.js";
import type { Stored, TeamService } from "../../packages/host/src/teams.js";
import { prepareMemberWorkspace } from "../../packages/host/src/team-workspace.js";
import { rand } from "../outcome-sim-script.js";
import { schedulerFixture } from "./team-scheduler.js";

const profiles = {
  gpt: { id: "writer-g", label: "Model G", provider: "codex", model: "gpt-6", effort: "high" },
  claude: { id: "writer-c", label: "Model C", provider: "claude", model: "claude-opus", effort: "high" },
  unknown: { id: "undetermined", label: "Unidentified model", provider: "opencode", model: "local/unidentified" },
} satisfies Record<string, TeamModelProfile>;
type Family = keyof typeof profiles;
type Fault = "drop-writer" | "change-reviewer" | "skip-family-gate";
type Scheduler = {
  record(id: string): Stored;
  consume(record: Stored, member: TeamMember): void;
  check(record: Stored): void;
};
const scheduler = (service: TeamService) => service as unknown as Scheduler;

async function simulateDelivery(seed: number, fault?: Fault) {
  const random = rand(seed);
  const f = schedulerFixture();
  const sourceMember = f.run.members[0]!;
  f.run.members = [];
  f.run.headCommit = f.run.baseCommit;
  f.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", "0"] }] };
  f.writeTeam({ deliveryReviewLineage: deliveryReviewLineageAtBase(f.run.baseCommit) });
  let service = f.openTeam();
  let record = scheduler(service).record(f.run.id);
  const authors = new Set<Family>();
  let accepted: { id: string; head: string; family: Family } | undefined;
  let checked: string | undefined;
  let step = 0;
  function invariants() {
    const message = (name: string) => `seed=${seed} step=${step} invariant=${name}`;
    const lineage = record.deliveryReviewLineage;
    const head = record.run.headCommit!;
    assert.equal(lineage?.headCommit, head, message("writer-history"));
    assert.deepEqual(lineage.families, [...authors].filter(family => family !== "unknown").sort(), message("writer-history"));
    assert.equal(lineage.unknown, authors.has("unknown"), message("writer-history"));
    if (accepted) {
      assert.equal(record.deliveryReviewApproval?.reviewerMemberId, accepted.id, message("accepted-review"));
      assert.equal(record.deliveryReviewApproval?.headCommit, accepted.head, message("accepted-review"));
    }
    const gateLineage = fault === "skip-family-gate" && accepted?.head === head
      ? { ...lineage, families: ["unrelated"], unknown: false } : lineage;
    const reason = automaticMergeReviewReason({ run: { ...record.run, checkHead: record.checkHead }, members: record.run.members,
      approval: record.deliveryReviewApproval, lineage: gateLineage });
    const eligible = Boolean(checked === head && accepted?.head === head && accepted.family !== "unknown" &&
      authors.size && !authors.has("unknown") && !authors.has(accepted.family));
    assert.equal(reason === undefined, eligible, message("independent-checked-head"));
  }
  async function settle() {
    const until = Date.now() + 20_000;
    while (record.pending && !record.pending.failure && Date.now() < until) await delay(10);
    assert.equal(record.pending, undefined, `seed=${seed} unresolved operation ${JSON.stringify(record.pending?.failure)}`);
    await service.idle();
  }
  async function reopen() {
    await service.close();
    if (fault === "drop-writer" || fault === "change-reviewer") {
      const saved = f.readRecord<Stored>("team", f.run.id);
      if (fault === "drop-writer" && saved.deliveryReviewLineage?.families.length) saved.deliveryReviewLineage.families = [];
      if (fault === "change-reviewer" && saved.deliveryReviewApproval) saved.deliveryReviewApproval.reviewerMemberId = "unaccepted-reviewer";
      f.writeRecord("team", f.run.id, saved);
    }
    service = f.openTeam();
    record = scheduler(service).record(f.run.id);
    invariants();
  }
  async function report(role: "implementer" | "reviewer", family: Family) {
    const run = record.run, id = randomUUID(), base = run.headCommit!;
    const cwd = await prepareMemberWorkspace(run.workspace, id, base);
    const member: TeamMember = { ...sourceMember, memberId: id, sessionId: randomUUID(), role, status: "stopped", revision: run.revision,
      provider: profiles[family].provider, modelProfile: profiles[family], cwd, baseCommit: base };
    run.members.push(member);
    if (role === "implementer") {
      const path = `change-${step}.txt`;
      member.taskId = `task-${step}`;
      run.tasks.push({ id: member.taskId, title: "Apply change", instructions: "Update the assigned file", paths: [path], dependsOn: [],
        status: "running", revision: run.revision, memberId: id });
      writeFileSync(join(cwd, path), "Reviewed change\n");
      member.report = { kind: "result", summary: "Updated the assigned file." };
      authors.add(family);
      checked = undefined;
    } else {
      member.report = { kind: "review", verdict: "approved", summary: "Reviewed the checked revision." };
      accepted = { id, head: base, family };
    }
    scheduler(service).consume(record, member);
    await settle();
    invariants();
  }
  try {
    const turns = random.int(2, 3);
    for (step = 1; step <= turns; step++) {
      const author: Family = step === 1 ? random.pick(["claude", "gpt"] as const) : random.pick(["claude", "gpt", "unknown"] as const);
      await report("implementer", author);
      if (random.chance(0.5)) await reopen();
      scheduler(service).check(record);
      await settle();
      checked = record.run.headCommit;
      assert.equal(record.checkHead, checked);
      invariants();
      const reviewer: Family = step === 1 ? author : random.pick(["claude", "gpt"] as const);
      await report("reviewer", reviewer);
      await reopen();
    }
  } finally {
    await service.close();
    f.close();
  }
}

const seed = Number(process.env.TEAM_SIM_SEED ?? 1);
test("seeded team delivery preserves exact authorship and review across restarts", { timeout: 120000 }, async t => {
  const seeds = process.env.TEAM_SIM_SEED === undefined ? [1, 2, 7, 13] : [seed];
  t.diagnostic(`delivery receipt seeds ${seeds.join(",")} (TEAM_SIM_SEED replays one)`);
  for (const value of seeds) await simulateDelivery(value);
});
for (const [fault, invariant] of [["drop-writer", "writer-history"], ["change-reviewer", "accepted-review"], ["skip-family-gate", "independent-checked-head"]] as const) {
  test(`delivery simulator catches ${fault} through ${invariant}`, { skip: process.env.TEAM_SIM_SEED !== undefined }, async () => {
    await assert.rejects(simulateDelivery(1, fault), new RegExp(`seed=1 step=1 invariant=${invariant}`));
  });
}
