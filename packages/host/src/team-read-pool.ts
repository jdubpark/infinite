import {
  applyReadEvent,
  emptyReadsState,
  type ReadRequestState,
  type ReadStepState,
  type ReadTransition,
  type ReadsState,
} from "./read-phases.js";
import {
  expandedTotal,
  readRequestSchema,
  stepKey,
  validateReadRequest,
  type ReadGrant,
  type ReadRequest,
  type ReadRequestError,
  type ReadStep,
} from "./read-request.js";
import { assertTaskProfiles, scoutPool } from "./routing-rules.js";
import { autoPinned, coversPoint, type TeamEvidence, type TeamRun, type TeamScout } from "./team-types.js";
import { TeamError } from "./team-workspace.js";

export type ReadStepSpec = ReadStep;

export interface ReadyReadStep {
  requestId: string;
  phaseId: string;
  step: ReadStepState;
  spec?: ReadStep;
}

export interface ReadPoolAdmitInput {
  requestId: string;
  requester: { role: "project-manager" | "scout-lead"; memberId: string };
  request: ReadRequest;
  allowanceLeft?: number;
  grant?: ReadGrant;
}

export type ReadPoolAdmitResult =
  | (ReadTransition & { ok: true })
  | (ReadTransition & { ok: false })
  | { ok: false; code: "invalid-request"; message: string; errors?: ReadRequestError[] };

export interface ReadStepFinding {
  requestId: string;
  stepId: string;
  status: "complete" | "partial" | "failed";
  summary?: string;
  evidence?: TeamEvidence[];
  reason?: string;
}

export interface ReadPoolSummary {
  revision?: number;
  requests: { total: number; running: number; ended: number; refused: number };
  steps: { queued: number; running: number; complete: number; partial: number; failed: number; joined: number; expanded: number; refused: number };
  settled: { requestId: string; stepId: string; status: "complete" | "partial" | "failed"; output?: string; items?: number }[];
}

export function baseReadStepId(stepId: string): string {
  const dot = stepId.indexOf(".");
  return dot >= 0 ? stepId.slice(0, dot) : stepId;
}

export function readStepToScout(ready: ReadyReadStep): TeamScout {
  const { step, spec } = ready;
  const suffix = step.item !== undefined ? ` [${step.item + 1}]` : "";
  const title = `${spec?.title ?? `Read step ${step.id}`}${suffix}`.slice(0, 100);
  const pathsNote = spec?.paths?.length ? `\nScoped paths: ${spec.paths.join(", ")}` : "";
  const listNote = step.list ? "\nReturn item findings so the host can count discovered items." : "";
  const instructions = `${spec?.instructions ?? `Execute read-only discovery step ${step.id}.`}${pathsNote}${listNote}`.slice(0, 4000);
  return {
    id: step.id,
    title,
    instructions,
    ...(spec?.agentProfileId ? { agentProfileId: spec.agentProfileId } : {}),
    status: "pending",
  };
}

export class TeamReadPool {
  private readonly specs = new Map<string, Map<string, ReadStep>>();
  private readonly findings = new Map<string, Map<string, ReadStepFinding>>();

  admit(stored: { run: TeamRun; readSpecs?: Record<string, Record<string, ReadStep>> }, input: ReadPoolAdmitInput): ReadPoolAdmitResult {
    const parsedRequest = readRequestSchema.safeParse(input.request);
    if (!parsedRequest.success) {
      return { ok: false, code: "invalid-request", message: "The read request does not match the read request schema." };
    }
    const request = structuredClone(parsedRequest.data);
    if (input.grant) {
      const checked = validateReadRequest(request, input.grant);
      if (!checked.ok) {
        return {
          ok: false,
          code: "invalid-request",
          message: checked.errors[0]?.message ?? "The read request was refused by the active read grant.",
          errors: checked.errors,
        };
      }
    }
    const defaultScout = stored.run.lineup && !(autoPinned(stored.run) && coversPoint(stored.run, "scout"))
      ? (scoutPool(stored.run).find(profile => profile.tier === "light") ?? scoutPool(stored.run)[0])
      : undefined;
    for (const phase of request.phases) {
      for (const step of phase.steps) {
        if (step.agentProfileId === undefined && defaultScout) step.agentProfileId = defaultScout.id;
      }
    }
    try {
      assertTaskProfiles(stored.run, request.phases.flatMap(phase => phase.steps), "scouts");
    } catch (error) {
      return {
        ok: false,
        code: "invalid-request",
        message: error instanceof TeamError ? error.message : "A read step specifies an invalid agent profile.",
      };
    }
    const totals = expandedTotal(request);
    const keys: Record<string, string> = {};
    const stepMap = new Map<string, ReadStep>();
    for (const phase of request.phases) {
      for (const step of phase.steps) {
        keys[step.id] = stepKey(step);
        stepMap.set(step.id, step);
      }
    }
    const current = stored.run.reads ?? emptyReadsState();
    const allowanceLeft = input.allowanceLeft ?? input.grant?.allowanceLeft ?? totals.total;
    const transition = applyReadEvent(current, {
      type: "admit",
      requestId: input.requestId,
      revision: stored.run.revision,
      requester: input.requester,
      request,
      keys,
      phaseTotals: totals.phases,
      allowanceLeft,
    });
    if (transition.ok) {
      this.specs.set(input.requestId, stepMap);
      (stored.readSpecs ??= {})[input.requestId] = Object.fromEntries(stepMap);
      if (transition.changed || !stored.run.reads) stored.run.reads = transition.state;
    }
    return transition;
  }

  private stepSpec(input: { run: TeamRun; readSpecs?: Record<string, Record<string, ReadStep>> } | TeamRun, requestId: string, stepId: string): ReadStep | undefined {
    const baseId = baseReadStepId(stepId);
    const inMemory = this.specs.get(requestId)?.get(baseId);
    if (inMemory) return inMemory;
    return "run" in input ? input.readSpecs?.[requestId]?.[baseId] : undefined;
  }

  nextReadySteps(input: { run: TeamRun; readSpecs?: Record<string, Record<string, ReadStep>> } | TeamRun, revision?: number): ReadyReadStep[] {
    const run = "run" in input ? input.run : input;
    const rev = revision ?? run.revision;
    const requests = run.reads?.requests ?? [];
    const ready: ReadyReadStep[] = [];
    for (const request of requests) {
      if (request.revision !== rev || request.status !== "running") continue;
      for (const phase of request.phases) {
        if (phase.status !== "started") continue;
        for (const step of phase.steps) {
          if (step.status !== "queued") continue;
          ready.push({
            requestId: request.id,
            phaseId: phase.id,
            step,
            spec: this.stepSpec(input, request.id, step.id),
          });
        }
      }
    }
    return ready;
  }

  markStarted(stored: { run: TeamRun }, requestId: string, stepId: string, memberId: string): ReadTransition {
    const current = stored.run.reads ?? emptyReadsState();
    const transition = applyReadEvent(current, { type: "start", requestId, stepId, memberId });
    if (transition.ok && transition.changed) stored.run.reads = transition.state;
    return transition;
  }

  settleStep(
    stored: { run: TeamRun; readFindings?: Record<string, ReadStepFinding> },
    requestId: string,
    stepId: string,
    status: "complete" | "partial" | "failed",
    output?: string,
    items?: number,
    detail?: { summary?: string; evidence?: TeamEvidence[]; reason?: string },
  ): ReadTransition {
    const current = stored.run.reads ?? emptyReadsState();
    const transition = applyReadEvent(current, {
      type: "settle",
      requestId,
      stepId,
      status,
      ...(output !== undefined ? { output } : {}),
      ...(items !== undefined ? { items } : {}),
    });
    if (!transition.ok) return transition;
    if (transition.changed) stored.run.reads = transition.state;
    if (detail) {
      const finding: ReadStepFinding = {
        requestId,
        stepId,
        status,
        ...(detail.summary !== undefined ? { summary: detail.summary } : {}),
        ...(detail.evidence !== undefined ? { evidence: detail.evidence } : {}),
        ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
      };
      const key = `${requestId}:${stepId}`;
      let runFindings = this.findings.get(stored.run.id);
      if (!runFindings) {
        runFindings = new Map();
        this.findings.set(stored.run.id, runFindings);
      }
      runFindings.set(key, finding);
      (stored.readFindings ??= {})[key] = finding;
    }
    return transition;
  }

  failMemberStep(stored: { run: TeamRun; readFindings?: Record<string, ReadStepFinding> }, memberId: string, reason: string): boolean {
    const match = this.findMemberStep(stored.run, memberId);
    if (!match) return false;
    const settled = this.settleStep(stored, match.request.id, match.step.id, "failed", undefined, undefined, { reason });
    return settled.ok;
  }

  findingsFor(stored: { run: TeamRun; readFindings?: Record<string, ReadStepFinding> }, revision = stored.run.revision): ReadStepFinding[] {
    const requestIds = new Set((stored.run.reads?.requests ?? []).filter(req => req.revision === revision).map(req => req.id));
    if (!requestIds.size) return [];
    const combined = new Map<string, ReadStepFinding>(this.findings.get(stored.run.id));
    for (const [key, value] of Object.entries(stored.readFindings ?? {})) combined.set(key, value);
    return [...combined.values()].filter(item => requestIds.has(item.requestId));
  }

  formatFindingsFeedback(stored: { run: TeamRun; readFindings?: Record<string, ReadStepFinding> }, revision = stored.run.revision): string | undefined {
    const list = this.findingsFor(stored, revision);
    if (!list.length) return undefined;
    const lines = list.map(item => {
      if (item.status === "failed") return `- ${item.stepId} (failed): ${item.reason ?? "No findings recorded."}`;
      const ev = (item.evidence ?? []).slice(0, 4).map(e => `${e.source}: ${e.observation}`).join("; ");
      return `- ${item.stepId} (${item.status}): ${item.summary ?? ""}${ev ? ` [${ev}]` : ""}`;
    });
    return `Read-only discovery pool findings (revision ${revision}):\n${lines.join("\n")}`;
  }

  findMemberStep(run: TeamRun, memberId: string, revision = run.revision): { request: ReadRequestState; phaseId: string; step: ReadStepState } | undefined {
    for (const request of run.reads?.requests ?? []) {
      if (request.revision !== revision) continue;
      for (const phase of request.phases) {
        const step = phase.steps.find(candidate => candidate.status === "running" && candidate.memberIds.includes(memberId));
        if (step) return { request, phaseId: phase.id, step };
      }
    }
    return undefined;
  }

  findScoutTask(input: { run: TeamRun; readSpecs?: Record<string, Record<string, ReadStep>> } | TeamRun, stepId: string, revision?: number): TeamScout | undefined {
    const run = "run" in input ? input.run : input;
    const rev = revision ?? run.revision;
    for (const request of run.reads?.requests ?? []) {
      if (request.revision !== rev) continue;
      for (const phase of request.phases) {
        const step = phase.steps.find(candidate => candidate.id === stepId);
        if (step) {
          return readStepToScout({
            requestId: request.id,
            phaseId: phase.id,
            step,
            spec: this.stepSpec(input, request.id, step.id),
          });
        }
      }
    }
    return undefined;
  }

  summary(state: ReadsState | undefined, revision?: number): ReadPoolSummary {
    const requests = (state?.requests ?? []).filter(request => revision === undefined || request.revision === revision);
    const steps: ReadPoolSummary["steps"] = { queued: 0, running: 0, complete: 0, partial: 0, failed: 0, joined: 0, expanded: 0, refused: 0 };
    const settled: ReadPoolSummary["settled"] = [];
    for (const request of requests) {
      for (const phase of request.phases) {
        for (const step of phase.steps) {
          if (step.status !== "pending") steps[step.status]++;
          if (step.status === "complete" || step.status === "partial" || step.status === "failed") {
            settled.push({
              requestId: request.id,
              stepId: step.id,
              status: step.status,
              ...(step.output !== undefined ? { output: step.output } : {}),
              ...(step.items !== undefined ? { items: step.items } : {}),
            });
          }
        }
      }
    }
    return {
      ...(revision !== undefined ? { revision } : {}),
      requests: {
        total: requests.length,
        running: requests.filter(r => r.status === "running").length,
        ended: requests.filter(r => r.status === "ended").length,
        refused: requests.filter(r => r.status === "refused").length,
      },
      steps,
      settled,
    };
  }
}
