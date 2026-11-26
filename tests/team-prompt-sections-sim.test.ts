import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TEAM_PROMPT_LIMIT_BYTES,
  appendStoredMemberPrompt,
  attachMemberScratchPrompt,
  codexMemberToolInstructions,
  codexSandboxInstructions,
  entryInstructions,
  getMemberPromptSections,
  profileInstructions,
  promptDigest,
  pruneMemberPromptSections,
  refreshMemberPromptForLaunch,
  renderPromptSections,
  reportingInstructions,
  retargetBuiltPrompt,
  scratchDirectoryInstructions,
  setMemberPromptSections,
  setStoredMemberPrompt,
  storedPromptSectionsEntry,
  storedWithPrunedPromptSections,
  teamPrompt,
  teamPromptSpec,
  type MemberPromptSectionStore,
  type TeamPromptSection,
} from "../packages/host/src/team-prompts.js";
import { intentCheckerPromptSpec } from "../packages/host/src/intent-prompt.js";
import { commitProviderLimitSwitch, resolveProviderLimitLaunch } from "../packages/host/src/team-diagnostics.js";
import { TeamError, type Stored } from "../packages/host/src/teams.js";
import type { TeamLineup, TeamMember, TeamModelProfile, TeamRun } from "../packages/host/src/team-types.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { smallRun } from "./fixtures/team-prompt-run.js";

type PromptSimMutant =
  | "none"
  | "leak-sections-on-member"
  | "drop-appended-section"
  | "stale-provider-blocks"
  | "bypass-refresh-byte-limit"
  | "bypass-scratch-byte-limit"
  | "apply-stale-rollback-sections"
  | "skip-legacy-retarget-upgrade"
  | "corrupt-switch-rollback"
  | "keep-orphan-sections-on-disk";

interface PromptSimCoverage {
  restarts: number;
  appends: number;
  sameProviderRefreshes: number;
  overLimitRefreshRefusals: number;
  scratchOverLimitRefusals: number;
  rollbackPromptOverwrites: number;
  legacyRetargetUpgrades: number;
  providerSwitches: number;
  switchRollbacks: number;
  permissionCoordinators: number;
  orphanPrunes: number;
}

const FROZEN_LEGACY_V1_ENTRY_RULE = "Working rule for tools: when you call tools through exec, do the reading, filtering, counting and comparing inside the program, and print only the result you need for your next decision. Do not print whole tool results. When a program lists or reads items, print how many it listed, read, and matched. Read the context file with a shell call inside a program, and select only the fields needed for your next decision. Tool signatures (arguments -> fields of a successful result's structuredContent): report({report}) -> {requestId, runId, memberId, revision, message}; entry_list({kinds?, taskId?, path?, since?, limit?}) -> {notice, heads, more, cursor?, unreadable}; entry_get({entryId}) -> {notice, head, body}; entry_post({entry}) -> {entryId, state, message}.";

const claudeLight: TeamModelProfile = {
  id: "claude-light",
  label: "Claude Light",
  provider: "claude",
  model: "claude-haiku-5-5",
  effort: "medium",
  tier: "light",
  limitFallback: "codex-fallback",
};
const codexPrimary: TeamModelProfile = {
  id: "codex-primary",
  label: "Codex Primary",
  provider: "codex",
  model: "gpt-6-astra",
  effort: "low",
  tier: "light",
  limitFallback: "opencode-fallback",
};
const codexFallback: TeamModelProfile = {
  id: "codex-fallback",
  label: "Codex Fallback",
  provider: "codex",
  model: "gpt-6-astra",
  effort: "low",
  tier: "light",
};
const opencodeFallback: TeamModelProfile = {
  id: "opencode-fallback",
  label: "OpenCode Fallback",
  provider: "opencode",
  model: "deepseek/deepseek-flash",
  variant: "high",
  tier: "light",
};
const strongCoord: TeamModelProfile = {
  id: "coord-strong",
  label: "Coord Strong",
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "xhigh",
  tier: "strong",
};
const strongReviewer: TeamModelProfile = {
  id: "rev-strong",
  label: "Reviewer Strong",
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "xhigh",
  tier: "strong",
};
const simLineup: TeamLineup = {
  coordinator: strongCoord,
  integrator: strongCoord,
  reviewer: strongReviewer,
  implementers: [claudeLight, codexPrimary],
  fallbacks: [codexFallback, opencodeFallback],
  escalations: [strongCoord, codexFallback, opencodeFallback],
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function baseHostRollbackProjection(member: TeamMember): Record<string, unknown> {
  const {
    prompt: _prompt,
    contextFeedback: _feedback,
    nativeSessionId: _nativeSessionId,
    goalCriteriaPlan: _goalCriteriaPlan,
    continuation: _continuation,
    turns: _turns,
    pendingFeedback: _pendingFeedback,
    ...rest
  } = member as TeamMember & Record<string, unknown>;
  return rest;
}

function runPromptStateSimulation(seed: number, mutant: PromptSimMutant): PromptSimCoverage {
  const rand = mulberry32(seed);
  const root = mkdtempSync(join(tmpdir(), "infinite-prompt-sim-"));
  const key = randomBytes(32);
  const sealPath = join(root, "team.sealed");
  const run: TeamRun = smallRun({
    id: randomUUID(),
    provider: "claude",
    blackboard: { tools: true },
    lineup: structuredClone(simLineup),
    status: "implementing",
    tasks: [
      { id: "t1", title: "Task 1", instructions: "Implement task 1", agentProfileId: "claude-light", paths: ["a.ts"], dependsOn: [], revision: 1, status: "running" },
      { id: "t2", title: "Task 2", instructions: "Implement task 2", agentProfileId: "codex-primary", paths: ["b.ts"], dependsOn: [], revision: 1, status: "running" },
    ],
    members: [],
  });
  let stored: Stored = { run, fingerprint: "sim", receipts: {}, prepared: true };
  const oracleNotes = new Map<string, string[]>();
  const permissionSentinels = new Set<string>();
  const staleMembers = new Set<string>();
  const promptOnlyMembers = new Set<string>();
  const coverage: PromptSimCoverage = {
    restarts: 0,
    appends: 0,
    sameProviderRefreshes: 0,
    overLimitRefreshRefusals: 0,
    scratchOverLimitRefusals: 0,
    rollbackPromptOverwrites: 0,
    legacyRetargetUpgrades: 0,
    providerSwitches: 0,
    switchRollbacks: 0,
    permissionCoordinators: 0,
    orphanPrunes: 0,
  };
  let now = Date.parse("2026-11-26T12:00:00.000Z");

  const saveDisk = () => {
    const payload = mutant === "keep-orphan-sections-on-disk" ? stored : storedWithPrunedPromptSections(stored);
    writeSealed(sealPath, key, `sim:${stored.run.id}`, payload);
  };

  const assertInvariants = (step: number) => {
    saveDisk();
    const disk = unseal<Stored>(key, `sim:${stored.run.id}`, readFileSync(sealPath, "utf8"));
    const liveById = new Map(disk.run.members.map(member => [member.memberId, member]));

    if (disk.memberPromptSections) {
      const diskKeys = Object.keys(disk.memberPromptSections);
      assert.ok(diskKeys.length > 0, `noOrphanSectionsOnDisk step=${step}: empty memberPromptSections object persisted`);
      for (const [memberId, entry] of Object.entries(disk.memberPromptSections)) {
        const liveMember = liveById.get(memberId);
        assert.ok(liveMember, `noOrphanSectionsOnDisk step=${step}: orphan section key ${memberId} on disk`);
        assert.equal(entry.promptSha256, promptDigest(liveMember.prompt), `noOrphanSectionsOnDisk step=${step}: mismatched promptSha256 persisted for ${memberId}`);
      }
    }

    for (const member of [...stored.run.members, ...disk.run.members]) {
      assert.equal("promptSections" in member, false, `noSectionsOnRunMembers step=${step}: promptSections leaked onto TeamMember ${member.memberId}`);
      const projected = baseHostRollbackProjection(member);
      const serialized = JSON.stringify(projected);
      assert.equal("promptSections" in projected, false, `rollbackViewPrivacy step=${step}: promptSections exposed in base-host TeamView`);
      for (const sentinel of permissionSentinels) {
        assert.equal(serialized.includes(sentinel), false, `rollbackViewPrivacy step=${step}: permission sentinel leaked in base-host TeamView`);
      }
    }

    for (const member of stored.run.members) {
      if (promptOnlyMembers.has(member.memberId)) {
        assert.equal(getMemberPromptSections(stored, member), undefined, `staleSectionsNeverOverwriteNewPrompt step=${step}: prompt-only member still bound to stale sections`);
        continue;
      }
      const sections = getMemberPromptSections(stored, member);
      assert.ok(Array.isArray(sections), `appendedAnswersPreserved step=${step}: missing structured sections for ${member.memberId}`);
      const notes = oracleNotes.get(member.memberId) ?? [];
      const rendered = renderPromptSections(sections, {
        provider: member.provider ?? stored.run.provider,
        profile: member.modelProfile,
        role: member.role,
        entryTools: member.entryTools === true,
      });
      for (const note of notes) {
        assert.ok(rendered.includes(note), `appendedAnswersPreserved step=${step}: missing note "${note}" in sections`);
        if (!staleMembers.has(member.memberId)) {
          assert.ok(member.prompt.includes(note), `appendedAnswersPreserved step=${step}: missing note "${note}" in prompt`);
        }
      }
      if (!staleMembers.has(member.memberId)) {
        assert.equal(member.prompt, rendered, `providerBlocksConsistent step=${step}: rendered prompt diverged from sections`);
        const provider = member.provider ?? stored.run.provider;
        const expectCodex = provider === "codex" && member.role !== "permission-coordinator";
        assert.equal(member.prompt.includes(codexSandboxInstructions), expectCodex, `providerBlocksConsistent step=${step}: codex sandbox mismatch`);
        assert.equal(member.prompt.includes(codexMemberToolInstructions(member.entryTools === true)), expectCodex, `providerBlocksConsistent step=${step}: codex rule mismatch`);
        assert.equal(member.prompt.includes(reportingInstructions(provider)), true, `providerBlocksConsistent step=${step}: reporting mismatch`);
        if (member.entryTools === true) {
          assert.equal(member.prompt.includes(entryInstructions(provider)), true, `providerBlocksConsistent step=${step}: entry mismatch`);
        }
        if (member.modelProfile) {
          assert.equal(member.prompt.includes(profileInstructions(member.modelProfile)), true, `providerBlocksConsistent step=${step}: profile mismatch`);
        }
      }
    }
  };

  const addMember = (role: "implementer" | "reviewer" | "intent-checker" | "permission-coordinator", step: number) => {
    const memberId = randomUUID();
    const profile = role === "permission-coordinator"
      ? strongReviewer
      : role === "implementer"
        ? (rand() < 0.5 ? claudeLight : codexPrimary)
        : role === "reviewer"
          ? strongReviewer
          : claudeLight;
    const provider = profile.provider;
    const task = role === "implementer" ? stored.run.tasks[profile.id === "codex-primary" ? 1 : 0] : undefined;
    const entryTools = role === "implementer" || role === "reviewer";
    let built: { prompt: string; promptSections: TeamPromptSection[] };
    if (role === "intent-checker") {
      built = intentCheckerPromptSpec(provider, profile);
    } else if (role === "permission-coordinator") {
      const sentinel = `PERM_SECRET_${seed}_${step}_${memberId.slice(0, 8)}`;
      permissionSentinels.add(sentinel);
      built = teamPromptSpec(stored.run, "permission-coordinator", undefined, `Permission request evidence ${sentinel}`, provider, profile);
      coverage.permissionCoordinators += 1;
    } else {
      built = teamPromptSpec(stored.run, role, task, undefined, provider, profile);
    }
    const member: TeamMember = {
      runId: stored.run.id,
      memberId,
      revision: 1,
      role,
      ...(task ? { taskId: task.id } : {}),
      ...(entryTools ? { entryTools: true as const } : {}),
      provider,
      modelProfile: structuredClone(profile),
      sessionId: randomUUID(),
      title: `${role}: ${task?.id ?? step}`,
      status: "queued",
      cwd: stored.run.workspace,
      baseCommit: stored.run.baseCommit,
      prompt: "",
      cursor: 0,
      stopRequestId: randomUUID(),
    };
    setStoredMemberPrompt(stored, member, built);
    if (mutant === "leak-sections-on-member") {
      (member as TeamMember & { promptSections?: TeamPromptSection[] }).promptSections = built.promptSections;
    }
    stored.run.members.push(member);
    oracleNotes.set(memberId, []);
    return member;
  };

  const runOverLimitRefreshCheck = (step: number) => {
    const base = teamPromptSpec(stored.run, "implementer", stored.run.tasks[1], undefined, "codex", codexPrimary);
    const overflow = TEAM_PROMPT_LIMIT_BYTES - Buffer.byteLength(base.prompt, "utf8") + 64;
    const sections: TeamPromptSection[] = [...base.promptSections, { kind: "text", text: "z".repeat(overflow) }];
    const memberId = randomUUID();
    const candidate: TeamMember = {
      runId: stored.run.id,
      memberId,
      revision: 1,
      role: "implementer",
      taskId: "t2",
      entryTools: true,
      provider: "codex",
      modelProfile: structuredClone(codexPrimary),
      sessionId: randomUUID(),
      title: `near-cap-${step}`,
      status: "queued",
      cwd: stored.run.workspace,
      baseCommit: stored.run.baseCommit,
      prompt: base.prompt,
      cursor: 0,
      stopRequestId: randomUUID(),
    };
    const tempStore: MemberPromptSectionStore = { memberPromptSections: { [memberId]: storedPromptSectionsEntry(base.prompt, sections) } };
    if (mutant === "bypass-refresh-byte-limit") {
      candidate.prompt = renderPromptSections(sections, { provider: "codex", profile: codexPrimary, role: "implementer", entryTools: true });
      assert.ok(Buffer.byteLength(candidate.prompt, "utf8") <= TEAM_PROMPT_LIMIT_BYTES, `refreshByteLimitEnforced step=${step}: accepted over-limit refreshed prompt`);
      return;
    }
    let refused = false;
    try {
      refreshMemberPromptForLaunch(tempStore, candidate, "codex");
    } catch (error) {
      refused = error instanceof TeamError && error.code === "team-prompt-too-large";
    }
    assert.equal(refused, true, `refreshByteLimitEnforced step=${step}: over-limit refresh must fail closed`);
    assert.equal(candidate.prompt, base.prompt, `refreshByteLimitEnforced step=${step}: failed refresh mutated prompt`);
    coverage.overLimitRefreshRefusals += 1;
  };

  const runScratchBoundaryCheck = (step: number) => {
    const base = teamPromptSpec(stored.run, "implementer", stored.run.tasks[1], undefined, "codex", codexPrimary);
    const nearCapPad = TEAM_PROMPT_LIMIT_BYTES - Buffer.byteLength(base.prompt, "utf8") - 80;
    const sections: TeamPromptSection[] = [...base.promptSections, { kind: "text", text: "s".repeat(nearCapPad) }];
    const rendered = renderPromptSections(sections, { provider: "codex", profile: codexPrimary, role: "implementer", entryTools: true });
    assert.ok(Buffer.byteLength(rendered, "utf8") <= TEAM_PROMPT_LIMIT_BYTES);
    const memberId = randomUUID();
    const candidate: TeamMember = {
      runId: stored.run.id,
      memberId,
      revision: 1,
      role: "implementer",
      taskId: "t2",
      entryTools: true,
      provider: "codex",
      modelProfile: structuredClone(codexPrimary),
      sessionId: randomUUID(),
      title: `scratch-cap-${step}`,
      status: "queued",
      cwd: stored.run.workspace,
      baseCommit: stored.run.baseCommit,
      prompt: rendered,
      cursor: 0,
      stopRequestId: randomUUID(),
    };
    const tempStore: MemberPromptSectionStore = { memberPromptSections: { [memberId]: storedPromptSectionsEntry(rendered, sections) } };
    assert.equal(refreshMemberPromptForLaunch(tempStore, candidate, "codex"), false);
    if (mutant === "bypass-scratch-byte-limit") {
      const note = scratchDirectoryInstructions("/srv/scratch/sim-overflow");
      candidate.scratchDirectory = "/srv/scratch/sim-overflow";
      appendStoredMemberPrompt(tempStore, candidate, note);
      assert.ok(Buffer.byteLength(candidate.prompt, "utf8") <= TEAM_PROMPT_LIMIT_BYTES, `scratchAppendByteLimitEnforced step=${step}: scratch append exceeded 80 KiB`);
      return;
    }
    let refused = false;
    try {
      attachMemberScratchPrompt(tempStore, candidate, () => "/srv/scratch/sim-overflow");
    } catch (error) {
      refused = error instanceof TeamError && error.code === "team-prompt-too-large";
    }
    assert.equal(refused, true, `scratchAppendByteLimitEnforced step=${step}: scratch append past 80 KiB must fail closed`);
    assert.equal(candidate.scratchDirectory, undefined, `scratchAppendByteLimitEnforced step=${step}: scratchDirectory mutated on refusal`);
    assert.equal(candidate.prompt, rendered, `scratchAppendByteLimitEnforced step=${step}: prompt mutated on refusal`);
    coverage.scratchOverLimitRefusals += 1;
  };

  const runRollbackOverwriteCheck = (step: number) => {
    const coord = stored.run.members.find(m => m.role === "permission-coordinator" && !promptOnlyMembers.has(m.memberId)) ?? addMember("permission-coordinator", step);
    const oldPrompt = coord.prompt;
    const rawOldEntry = stored.memberPromptSections?.[coord.memberId];
    assert.ok(rawOldEntry);
    const newSentinel = `ROLLBACK_TURN_${seed}_${step}_${coord.memberId.slice(0, 8)}`;
    permissionSentinels.add(newSentinel);
    const newTurnPrompt = teamPrompt(stored.run, "permission-coordinator", undefined, `Rolled-back host decision ${newSentinel}`, "claude", strongReviewer);
    coord.prompt = newTurnPrompt;
    if (mutant === "apply-stale-rollback-sections") {
      coord.prompt = renderPromptSections(rawOldEntry.sections, { provider: "claude", profile: coord.modelProfile, role: "permission-coordinator", entryTools: false });
      assert.equal(coord.prompt, newTurnPrompt, `staleSectionsNeverOverwriteNewPrompt step=${step}: stale sections overwrote newer permission prompt`);
      return;
    }
    assert.equal(getMemberPromptSections(stored, coord), undefined, `staleSectionsNeverOverwriteNewPrompt step=${step}: mismatched sections were not ignored`);
    refreshMemberPromptForLaunch(stored, coord, stored.run.provider);
    assert.equal(coord.prompt, newTurnPrompt, `staleSectionsNeverOverwriteNewPrompt step=${step}: newer permission prompt was overwritten`);
    assert.notEqual(coord.prompt, oldPrompt);
    promptOnlyMembers.add(coord.memberId);
    coverage.rollbackPromptOverwrites += 1;
  };

  const runLegacyRetargetUpgradeCheck = (step: number) => {
    const legacyPrompt = teamPrompt(stored.run, "implementer", stored.run.tasks[1], undefined, "codex", codexPrimary)
      .replace(codexMemberToolInstructions(true), FROZEN_LEGACY_V1_ENTRY_RULE);
    const retargeted = retargetBuiltPrompt(
      { prompt: legacyPrompt },
      { provider: "opencode", profile: opencodeFallback, role: "implementer", entryTools: true },
    );
    assert.ok(retargeted);
    const upgraded = mutant === "skip-legacy-retarget-upgrade" ? { prompt: retargeted.prompt } : retargeted;
    assert.ok(Array.isArray(upgraded.promptSections), `legacyRetargetUpgradesToSections step=${step}: unambiguous legacy retarget must emit structured sections`);
    const reRendered = renderPromptSections(upgraded.promptSections!, {
      provider: "opencode",
      profile: opencodeFallback,
      role: "implementer",
      entryTools: true,
    });
    assert.equal(reRendered, upgraded.prompt, `legacyRetargetUpgradesToSections step=${step}: upgraded sections must re-render identically`);
    coverage.legacyRetargetUpgrades += 1;
  };

  try {
    addMember("implementer", 0);
    addMember("permission-coordinator", 1);
    assertInvariants(0);

    for (let step = 1; step <= 40; step++) {
      now += 60_000;
      const structuredMembers = stored.run.members.filter(m => !promptOnlyMembers.has(m.memberId));
      const queuedImplementers = structuredMembers.filter(m => m.role === "implementer" && m.status === "queued");

      if (step === 4) {
        const orphanId = randomUUID();
        setMemberPromptSections(stored, orphanId, [{ kind: "text", text: "orphan" }], "orphan");
        assertInvariants(step);
        const pruned = pruneMemberPromptSections(stored, stored.run.members);
        assert.equal(pruned, true);
        coverage.orphanPrunes += 1;
        continue;
      }
      if (step === 8) {
        runOverLimitRefreshCheck(step);
        assertInvariants(step);
        continue;
      }
      if (step === 12) {
        runRollbackOverwriteCheck(step);
        assertInvariants(step);
        continue;
      }
      if (step === 16) {
        runScratchBoundaryCheck(step);
        assertInvariants(step);
        continue;
      }
      if (step === 20) {
        runLegacyRetargetUpgradeCheck(step);
        assertInvariants(step);
        continue;
      }

      const roll = rand();
      if (roll < 0.22 && stored.run.members.length < 7) {
        const roles = ["implementer", "reviewer", "intent-checker", "permission-coordinator"] as const;
        addMember(roles[Math.floor(rand() * roles.length)]!, step);
      } else if (roll < 0.42 && structuredMembers.length > 0) {
        const target = structuredMembers[Math.floor(rand() * structuredMembers.length)]!;
        const note = `User answered step ${step}: decision-${seed}-${step}`;
        if (mutant === "drop-appended-section") {
          const oldSections = getMemberPromptSections(stored, target)!;
          target.prompt = `${target.prompt}\n\n${note}`;
          setMemberPromptSections(stored, target.memberId, oldSections, target.prompt);
        } else {
          appendStoredMemberPrompt(stored, target, note);
        }
        oracleNotes.get(target.memberId)!.push(note);
        coverage.appends += 1;
      } else if (roll < 0.62 && structuredMembers.length > 0) {
        const target = structuredMembers[Math.floor(rand() * structuredMembers.length)]!;
        const currentSections = getMemberPromptSections(stored, target)!;
        const staleProse = `Pre-upgrade stale prompt step ${step}`;
        const existingNotes = oracleNotes.get(target.memberId) ?? [];
        target.prompt = [staleProse, ...existingNotes].join("\n\n");
        setMemberPromptSections(stored, target.memberId, currentSections, target.prompt);
        staleMembers.add(target.memberId);
        if (mutant === "stale-provider-blocks") {
          staleMembers.delete(target.memberId);
        } else {
          const refreshed = refreshMemberPromptForLaunch(stored, target, stored.run.provider);
          assert.equal(refreshed, true);
          staleMembers.delete(target.memberId);
        }
        coverage.sameProviderRefreshes += 1;
      } else if (roll < 0.84 && queuedImplementers.length > 0) {
        const target = queuedImplementers[Math.floor(rand() * queuedImplementers.length)]!;
        const provider = target.provider ?? stored.run.provider;
        const limit = {
          provider,
          detectedAt: new Date(now).toISOString(),
          resetsAt: new Date(now + 10 * 60_000).toISOString(),
          expiresAt: new Date(now + 10 * 60_000).toISOString(),
          sessionId: `lim-${step}`,
          confidence: "corroborated" as const,
        };
        const decision = resolveProviderLimitLaunch(
          stored.run,
          target,
          [limit],
          new Set([provider]),
          undefined,
          getMemberPromptSections(stored, target),
        );
        if (decision.kind === "switch") {
          const beforePrompt = target.prompt;
          const beforeProvider = target.provider;
          const beforeProfile = structuredClone(target.modelProfile);
          const beforeSections = structuredClone(getMemberPromptSections(stored, target));
          const undo = commitProviderLimitSwitch(stored.run, target, decision, text => stored.run.events.push({ at: new Date(now).toISOString(), text }), stored);
          staleMembers.delete(target.memberId);
          const doRollback = step % 2 === 0 || coverage.switchRollbacks === 0;
          if (doRollback) {
            assert.equal(undo(), true);
            if (mutant === "corrupt-switch-rollback") {
              setMemberPromptSections(stored, target.memberId, decision.promptSections, beforePrompt);
            }
            assert.equal(target.prompt, beforePrompt, `switchRollbackExact step=${step}: prompt mismatch after undo`);
            assert.equal(target.provider, beforeProvider, `switchRollbackExact step=${step}: provider mismatch after undo`);
            assert.deepEqual(target.modelProfile, beforeProfile, `switchRollbackExact step=${step}: profile mismatch after undo`);
            assert.deepEqual(getMemberPromptSections(stored, target), beforeSections, `switchRollbackExact step=${step}: sections mismatch after undo`);
            coverage.switchRollbacks += 1;
          } else {
            coverage.providerSwitches += 1;
          }
        }
      } else {
        saveDisk();
        stored = unseal<Stored>(key, `sim:${stored.run.id}`, readFileSync(sealPath, "utf8"));
        pruneMemberPromptSections(stored, stored.run.members);
        coverage.restarts += 1;
      }

      assertInvariants(step);
    }

    if (coverage.providerSwitches === 0) {
      const imp = stored.run.members.find(m => !promptOnlyMembers.has(m.memberId) && m.role === "implementer" && (m.modelProfile?.id === "claude-light" || m.modelProfile?.id === "codex-primary")) ?? addMember("implementer", 41);
      const provider = imp.provider ?? stored.run.provider;
      const limit = {
        provider,
        detectedAt: new Date(now).toISOString(),
        resetsAt: new Date(now + 10 * 60_000).toISOString(),
        expiresAt: new Date(now + 10 * 60_000).toISOString(),
        sessionId: "lim-final",
        confidence: "corroborated" as const,
      };
      const decision = resolveProviderLimitLaunch(stored.run, imp, [limit], new Set([provider]), undefined, getMemberPromptSections(stored, imp));
      assert.equal(decision.kind, "switch");
      commitProviderLimitSwitch(stored.run, imp, decision, text => stored.run.events.push({ at: new Date(now).toISOString(), text }), stored);
      coverage.providerSwitches += 1;
      assertInvariants(41);
    }

    return coverage;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("seeded structured-prompt durable-state simulator enforces storage privacy, digest binding, byte limits, legacy upgrade, and switch invariants across seeds and catches all named mutants", t => {
  const override = process.env.SIM_SEED ? Number.parseInt(process.env.SIM_SEED, 10) : undefined;
  const seeds = Number.isFinite(override) ? [override!] : [101, 202, 303, 404, 505, 606, 707, 808];
  const totals: PromptSimCoverage = {
    restarts: 0,
    appends: 0,
    sameProviderRefreshes: 0,
    overLimitRefreshRefusals: 0,
    scratchOverLimitRefusals: 0,
    rollbackPromptOverwrites: 0,
    legacyRetargetUpgrades: 0,
    providerSwitches: 0,
    switchRollbacks: 0,
    permissionCoordinators: 0,
    orphanPrunes: 0,
  };
  for (const seed of seeds) {
    t.diagnostic(`structured-prompt simulator seed=${seed}`);
    const run = runPromptStateSimulation(seed, "none");
    for (const key of Object.keys(totals) as (keyof PromptSimCoverage)[]) totals[key] += run[key];
  }
  for (const [key, count] of Object.entries(totals)) {
    assert.ok(count > 0, `simulator coverage counter ${key} must be > 0 (got ${count})`);
  }

  const expectedMutants: Array<[PromptSimMutant, RegExp]> = [
    ["leak-sections-on-member", /noSectionsOnRunMembers|rollbackViewPrivacy/],
    ["drop-appended-section", /appendedAnswersPreserved/],
    ["stale-provider-blocks", /providerBlocksConsistent/],
    ["bypass-refresh-byte-limit", /refreshByteLimitEnforced/],
    ["bypass-scratch-byte-limit", /scratchAppendByteLimitEnforced/],
    ["apply-stale-rollback-sections", /staleSectionsNeverOverwriteNewPrompt/],
    ["skip-legacy-retarget-upgrade", /legacyRetargetUpgradesToSections/],
    ["corrupt-switch-rollback", /switchRollbackExact/],
    ["keep-orphan-sections-on-disk", /noOrphanSectionsOnDisk/],
  ];
  for (const [mutant, pattern] of expectedMutants) {
    assert.throws(() => runPromptStateSimulation(seeds[0]!, mutant), pattern, `simulator must catch mutant ${mutant}`);
  }
});
