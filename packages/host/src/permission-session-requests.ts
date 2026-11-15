/**
 * Permission requests of sessions outside team runs: the session requester adapter and its trigger.
 *
 * A session that the owner starts in a workspace raises an interactive permission dialog. This module
 * builds the request and its live target from the host's own session record and hands the target to
 * the delivery service, which decides it through the pipeline. Without a delivery service, or when the
 * delivery service does not serve the request, nothing here acts: the request stays with the owner, with
 * today's notifications. A team member's session, a mission coordinator and a session whose tools run
 * on a laptop never take this path.
 */
import { realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { dialogCommand, matchDestructive, oneShotPermissionOption, type AnswerResult, type Prompt, type PromptOption } from "@infinite/attention";
import { handoffNativePrompt } from "./handoff-types.js";
import { permissionEvidenceHash, permissionReuseKey, refusedBeforeSend } from "./team-permissions.js";
import type { PermissionDeliveryService, PermissionInteractiveTarget, PermissionRequest, PermissionRequestShape } from "./permission-agent-types.js";
import type { AgentProfile, Config, Event, Project, Receipt, Session, WorkerState } from "./types.js";

/** The control lease label of the host's own answer. A lease with it is not a person. */
export const SESSION_PERMISSION_ACTOR_LABEL = "Session permission";
const ACTION_LIMIT = 2_000;
const TITLE_LIMIT = 200;
const TASK_TEXT_LIMIT = 8_000;
const FIRST_PROMPT_LIMIT = 3_000;
/** Journal pages read for owner prompts per request. A page is at most 512 KB of journal. */
const TASK_SCAN_PAGES = 16;
/** Earlier sessions of a resumed conversation whose owner prompts count as this session's task. */
const RESUME_HOPS = 4;
/** Submitted owner prompts kept per session, newest first. */
const KEPT_PROMPTS = 64;

/* ---------------------------------------------------------------- one-shot choices */

/** A label that grants or refuses more than this one action, or that ends the session. */
const PERSISTENT_LABEL = /always|trust|workspace|project|folder|remember|future|session|don't ask|do not ask|exit|quit/i;
const TRUST = /\btrust\b/i;
const CANONICAL_CHOICES: PromptOption[] = [{ index: 0, label: "Yes", role: "accept" }, { index: 1, label: "No", role: "reject" }];
/** A dialog with complete hook evidence, used to read the accept-label rule of `oneShotPermissionOption` on its own. */
const COMPLETE_PROBE: Prompt = {
  id: 1, kind: "permission", title: "", options: [], acceptsText: false, source: "hook", hash: "0".repeat(64),
  tool: { name: "probe", input: { probe: true }, inputComplete: true },
};
const isReject = (option: PromptOption) => option.role === "reject" || option.role === "reject-with-feedback";

/**
 * The recognised one-shot choices of a permission dialog, read with the team path's qualification
 * (`oneShotPermissionOption`). The destructive flag is set aside: it raises a request, it does not
 * disqualify it. `accept` is set only when the evidence is complete as well.
 */
export function permissionChoices(prompt: Prompt): { accept?: number; reject?: number; shape: PermissionRequestShape } {
  const structural: Prompt = { ...prompt, destructive: undefined };
  const accept = oneShotPermissionOption(structural);
  const completeEvidence = oneShotPermissionOption({ ...structural, options: CANONICAL_CHOICES }) !== undefined;
  const offeredAccept = oneShotPermissionOption({ ...COMPLETE_PROBE, options: [...prompt.options.filter(option => !isReject(option)), { index: -1, label: "No", role: "reject" }] });
  const rejects = prompt.options.filter(option => isReject(option) && !PERSISTENT_LABEL.test(option.label));
  const reject = (rejects.find(option => option.role === "reject") ?? rejects[0])?.index;
  const persistentOnly = offeredAccept === undefined &&
    prompt.options.some(option => option.role === "accept-always" || option.role === "accept" && PERSISTENT_LABEL.test(option.label));
  return {
    ...(accept !== undefined ? { accept } : {}),
    ...(reject !== undefined ? { reject } : {}),
    shape: {
      completeEvidence, oneShotAccept: offeredAccept !== undefined, oneShotReject: reject !== undefined, persistentOnly,
      trustPrompt: TRUST.test(prompt.title) || prompt.options.some(option => TRUST.test(option.label)),
    },
  };
}

/** The command or action the dialog asks for, as the host extracts it. */
export function permissionAction(prompt: Prompt): string {
  const input = prompt.tool?.input;
  const text = typeof input?.command === "string" ? input.command
    : prompt.tool ? `${prompt.tool.name} ${JSON.stringify(input ?? {})}`
      : dialogCommand(prompt) ?? [prompt.title, prompt.detail].filter(Boolean).join("\n");
  return text.slice(0, ACTION_LIMIT);
}

/* ---------------------------------------------------------------- requester */

/** A row of a session listing: the session record without its prompts, plus the worker state. */
export type ListedSession = Pick<Session, "id" | "projectId"> &
  Partial<Pick<Session, "team" | "workspace" | "executionLocation" | "runtime">> &
  Pick<WorkerState, "status" | "attention"> & Partial<Pick<WorkerState, "control">>;

/**
 * A host session outside any team run whose tools run on the host and whose dialogs the host answers on
 * its own terminal. A mission coordinator carries a team assignment, so it is excluded here too.
 */
export function outsideRun(session: Partial<Pick<Session, "team" | "workspace" | "executionLocation" | "runtime">>): boolean {
  return !session.team && !session.workspace && session.executionLocation !== "laptop" &&
    session.runtime?.transport === "pty" && !session.runtime.nativeUi;
}

/** A control lease held by a person. The host's own answer lease is not one. */
const personHolds = (control: WorkerState["control"]) => Boolean(control && control.label !== SESSION_PERMISSION_ACTOR_LABEL);

/** The canonical checkout of the session's project, when it is still the one the session was created in. */
export function sessionRootOf(session: Pick<Session, "projectRoot">, project: Pick<Project, "path"> | undefined): string | undefined {
  if (!project) return undefined;
  let root: string;
  try { root = realpathSync(project.path); } catch { return undefined; }
  return session.projectRoot === undefined || session.projectRoot === root ? root : undefined;
}

const canonical = (path: string) => { try { return realpathSync(path); } catch { return undefined; } };
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); };

/** The model of the session's launch profile: its configured arguments, then the owner's native arguments. */
export function launchModel(session: Pick<Session, "provider" | "nativeArgs">, profile: Pick<AgentProfile, "args"> | undefined): string | undefined {
  const args = [...(profile?.args ?? []), ...(session.nativeArgs ?? [])];
  let model: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--model" || arg === "-m" && session.provider !== "claude") model = args[++index];
    else if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
  }
  return model && /^[\w.:/@-]{1,120}$/.test(model) ? model : undefined;
}

/**
 * What the session was asked to do: the owner's own prompts, oldest first, bounded. The first prompt is
 * kept; later ones are kept newest first while they fit. `notes` are host-written gaps in the record.
 */
export function taskText(prompts: string[], notes: string[] = []): string {
  const header = "Prompts that the owner submitted through the host, oldest first. They are the owner's words, not agent output.";
  if (!prompts.length) return [header, "(No owner prompt was recorded for this session.)", ...notes].join("\n");
  const [first, ...rest] = prompts;
  const opening = `--- Owner prompt 1 ---\n${first.slice(0, FIRST_PROMPT_LIMIT)}`;
  let budget = TASK_TEXT_LIMIT - header.length - opening.length - notes.join("\n").length - 200;
  const later: string[] = [];
  let omitted = 0;
  for (let index = rest.length - 1; index >= 0; index--) {
    const section = `--- Owner prompt ${index + 2} ---\n${rest[index]}`;
    if (section.length + 1 > budget) { omitted = index + 1; break; }
    budget -= section.length + 1;
    later.unshift(section);
  }
  const gaps = [...notes, ...(omitted ? [`(${omitted} owner prompt${omitted === 1 ? "" : "s"} after the first omitted for length.)`] : [])];
  return [header, opening, ...gaps, ...later].join("\n").slice(0, TASK_TEXT_LIMIT);
}

export interface SessionPermissionRequestInput {
  session: Session;
  sessionRoot: string;
  prompt: Prompt;
  task: { title: string; text: string };
  model?: string;
  /** The authority hash of the project's delegation. Without one the request has no reuse key. */
  authority?: string;
}

/** The request for one dialog of a session outside a run. Every field comes from host records. */
export function sessionPermissionRequest(input: SessionPermissionRequestInput): PermissionRequest {
  const { session, prompt } = input;
  const choices = permissionChoices(prompt);
  const evidenceHash = permissionEvidenceHash(prompt);
  const action = permissionAction(prompt);
  const matched = prompt.destructive ?? (() => { const pattern = matchDestructive(action); return pattern ? { pattern } : undefined; })();
  const reuseKey = input.authority && choices.accept !== undefined
    ? permissionReuseKey({ policyHash: input.authority, prompt, option: choices.accept, targetTaskId: session.id, changedPaths: [], acceptedChecks: null })
    : undefined;
  return {
    id: `session:${session.id}:${prompt.id}:${evidenceHash.slice(0, 16)}`,
    requester: {
      kind: "session", sessionId: session.id, projectId: session.projectId, taskId: session.id, assignment: session.id,
      provider: session.provider, ...(input.model ? { model: input.model } : {}),
      sessionRoot: input.sessionRoot, scratchRoots: [], task: input.task,
    },
    tool: prompt.tool?.name ?? "dialog",
    ...(prompt.tool?.inputComplete ? { input: prompt.tool.input } : {}),
    action,
    prompt,
    ...(matched ? { destructive: { pattern: matched.pattern } } : {}),
    shape: choices.shape,
    evidenceHash,
    ...(reuseKey ? { reuseKey } : {}),
  };
}

/* ---------------------------------------------------------------- service */

export interface SessionPermissionAnswer {
  decisionId: string;
  option: number;
  promptId: number;
  promptHash: string;
  evidenceHash: string;
  /** Canonical working directory of the session when the request was built. */
  targetCwd: string;
}

/** The host operations this module uses. `Manager` provides them. */
export interface SessionPermissionHost {
  meta(id: string): { session: Session };
  state(id: string): Promise<WorkerState>;
  events(id: string, after: number, limit: number, types?: Set<string>): { events: Event[]; cursor: number; more: boolean };
  answerSessionPermission(sessionId: string, input: SessionPermissionAnswer): Promise<Receipt & { result?: AnswerResult }>;
}

/** The parts of the permission agent this module reads. Each is read on every use, so a part registered later is seen. */
export interface SessionPermissionParts {
  delivery(): PermissionDeliveryService | undefined;
  /** Whether the host serves the project now. Without it, the delivery service decides coverage alone. */
  serves?(projectId: string): boolean;
  /** The authority hash of the project's delegation, for the reuse key. */
  authority?(projectId: string): string | undefined;
  /** A session outside a run is its own task. Its end closes the task's open rejects and ends its locks. */
  taskEnded?(taskId: string): void;
}

type Tracked = { key: string; promptId: number; phase: "building" | "handed" | "owner"; inFlight: boolean };
type TaskScan = { cursor: number; prompts: string[]; complete: boolean; dropped: number };

/**
 * Follows session listings for permission dialogs of sessions outside team runs and hands each one,
 * once, to the delivery service. `holder` tells the notifier whose a pending dialog is.
 */
export class SessionPermissionRequests {
  private readonly prompts = new Map<string, Tracked>();
  /** Sessions outside a run that were seen running, so their end reaches the pipeline once. */
  private readonly running = new Set<string>();
  private readonly scans = new Map<string, TaskScan>();
  /** Listed sessions that carry no team assignment. Their dialogs are this module's to place; a team member's are not. */
  private readonly unassigned = new Set<string>();

  constructor(
    private readonly config: Pick<Config, "projects" | "agents">,
    private readonly host: SessionPermissionHost,
    private readonly parts: SessionPermissionParts,
  ) {}

  /** Reads one session listing. It never throws and never waits: a dialog to hand is built in the background. */
  observe(rows: readonly ListedSession[]): void {
    const delivery = this.parts.delivery();
    const listed = new Set<string>();
    for (const row of rows) {
      listed.add(row.id);
      if (row.team) this.unassigned.delete(row.id); else this.unassigned.add(row.id);
      if (!outsideRun(row)) continue;
      this.followTask(row);
      const prompt = row.attention?.prompt;
      const tracked = this.prompts.get(row.id);
      if (row.status !== "running" || row.attention?.state !== "needs-you" || !prompt || prompt.kind !== "permission" || !prompt.hash) {
        if (tracked && !tracked.inFlight) this.prompts.delete(row.id);
        continue;
      }
      const key = `${prompt.id}:${prompt.hash}`;
      if (tracked?.key === key) continue;
      // One decision per dialog at a time. A dialog that changed while its predecessor is decided is read again on a later listing.
      if (tracked?.inFlight) continue;
      if (!delivery) { this.prompts.delete(row.id); continue; }
      if (personHolds(row.control ?? null) || !this.served(row.projectId)) {
        // A person holds input control, or the host does not serve the project: the request is the owner's, as today.
        this.prompts.set(row.id, { key, promptId: prompt.id, phase: "owner", inFlight: false });
        continue;
      }
      this.prompts.set(row.id, { key, promptId: prompt.id, phase: "building", inFlight: true });
      void this.hand(row.id, key, delivery);
    }
    for (const [id, tracked] of this.prompts) if (!listed.has(id) && !tracked.inFlight) this.prompts.delete(id);
    for (const id of this.unassigned) if (!listed.has(id)) this.unassigned.delete(id);
  }

  /**
   * Whose a pending dialog is, for the notifier. A dialog of a session without a team assignment is the
   * owner's unless this module handed it; then the delivery service answers. A team member's dialog, or a
   * session not listed yet, is the delivery service's to answer for.
   */
  holder(sessionId: string, promptId: number): "agent" | "owner" | "undecided" {
    const tracked = this.prompts.get(sessionId)?.promptId === promptId ? this.prompts.get(sessionId) : undefined;
    if (tracked?.phase === "building") return "undecided";
    if (tracked?.phase === "owner" || !tracked && this.unassigned.has(sessionId)) return "owner";
    const delivery = this.parts.delivery();
    if (!delivery) return "owner";
    try { return delivery.holder(sessionId, promptId); } catch { return "owner"; }
  }

  /** Builds the live target of the session's current dialog, or undefined when the session does not take this path now. */
  async target(sessionId: string, expectedKey?: string): Promise<PermissionInteractiveTarget | undefined> {
    const session = this.host.meta(sessionId).session;
    if (!outsideRun(session)) return undefined;
    const sessionRoot = sessionRootOf(session, this.project(session.projectId));
    const cwd = canonical(session.cwd);
    if (!sessionRoot || !cwd || !inside(sessionRoot, cwd)) return undefined;
    const state = await this.host.state(sessionId);
    const prompt = state.attention?.prompt;
    if (state.status !== "running" || personHolds(state.control ?? null) || state.attention.state !== "needs-you" ||
        !prompt || prompt.kind !== "permission" || !prompt.hash || expectedKey !== undefined && `${prompt.id}:${prompt.hash}` !== expectedKey)
      return undefined;
    const request = sessionPermissionRequest({
      session, sessionRoot, prompt, task: this.task(session), model: launchModel(session, this.config.agents[session.provider]),
      authority: this.safe(() => this.parts.authority?.(session.projectId)),
    });
    const answers = new Map<string, Promise<"delivered" | "refused" | "uncertain">>();
    return {
      request,
      check: () => this.check(sessionId, request, prompt, sessionRoot, cwd),
      answer: (option, decisionId) => {
        // One decision is answered once. A second call returns the first result and sends nothing.
        const previous = answers.get(decisionId);
        if (previous) return previous;
        const result = (async () => {
          // The live checks run again here, so no key is sent to a session a person now controls, whatever the caller checked.
          const live = await this.check(sessionId, request, prompt, sessionRoot, cwd);
          if (!live.ok || option !== live.accept && option !== live.reject) return "refused" as const;
          return this.answer(sessionId, prompt, request.evidenceHash, cwd, option, decisionId);
        })();
        answers.set(decisionId, result);
        return result;
      },
    };
  }

  private async hand(sessionId: string, key: string, delivery: PermissionDeliveryService) {
    let phase: Tracked["phase"] = "owner";
    try {
      const target = await this.target(sessionId, key);
      if (!target) return;
      const handled = delivery.handle(target);
      this.mark(sessionId, key, "handed", true);
      phase = (await handled).handled ? "handed" : "owner";
    } catch { phase = "owner"; }
    finally { this.mark(sessionId, key, phase, false); }
  }

  private mark(sessionId: string, key: string, phase: Tracked["phase"], inFlight: boolean) {
    const tracked = this.prompts.get(sessionId);
    if (tracked?.key === key) this.prompts.set(sessionId, { ...tracked, phase, inFlight });
  }

  private async check(sessionId: string, request: PermissionRequest, reviewed: Prompt, sessionRoot: string, cwd: string):
    ReturnType<PermissionInteractiveTarget["check"]> {
    let session: Session;
    try { session = this.host.meta(sessionId).session; }
    catch { return { ok: false, stale: true, reason: "The session record is gone." }; }
    if (!outsideRun(session) || session.projectId !== request.requester.projectId)
      return { ok: false, stale: false, reason: "The session no longer runs outside a team run on this host." };
    let state: WorkerState;
    try { state = await this.host.state(sessionId); }
    catch { return { ok: false, stale: false, reason: "The session state cannot be read." }; }
    if (state.status !== "running") return { ok: false, stale: true, reason: "The session is no longer running." };
    const prompt = state.attention?.prompt;
    if (state.attention?.state !== "needs-you" || !prompt || prompt.id !== reviewed.id || prompt.hash !== reviewed.hash ||
        permissionEvidenceHash(prompt) !== request.evidenceHash)
      return { ok: false, stale: true, reason: "The request changed or closed." };
    if (sessionRootOf(session, this.project(session.projectId)) !== sessionRoot || canonical(session.cwd) !== cwd)
      return { ok: false, stale: false, reason: "The session root changed." };
    if (personHolds(state.control ?? null)) return { ok: false, stale: false, reason: "A person holds input control of the session." };
    const { accept, reject } = permissionChoices(prompt);
    return { ok: true, ...(accept !== undefined ? { accept } : {}), ...(reject !== undefined ? { reject } : {}) };
  }

  private async answer(sessionId: string, prompt: Prompt, evidenceHash: string, cwd: string, option: number, decisionId: string) {
    try {
      const receipt = await this.host.answerSessionPermission(sessionId, {
        decisionId, option, promptId: prompt.id, promptHash: prompt.hash!, evidenceHash, targetCwd: cwd,
      });
      // A dialog that stayed open, or a marker that never reached the option, may have taken keys: never retried.
      return receipt.state === "delivered" && receipt.result === "closed" ? "delivered" as const : "uncertain" as const;
    } catch (error) {
      return refusedBeforeSend(error) ? "refused" as const : "uncertain" as const;
    }
  }

  private followTask(row: ListedSession) {
    if (row.status === "running" || row.status === "starting") { this.running.add(row.id); return; }
    if (row.status !== "exited" || !this.running.delete(row.id)) return;
    this.scans.delete(row.id);
    this.prompts.delete(row.id);
    this.safe(() => this.parts.taskEnded?.(row.id));
  }

  private served(projectId: string): boolean {
    if (!this.parts.serves) return true;
    return this.safe(() => this.parts.serves!(projectId)) === true;
  }

  private project(projectId: string) {
    const matches = this.config.projects.filter(project => project.id === projectId);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private safe<T>(read: () => T): T | undefined { try { return read(); } catch { return undefined; } }

  /** The session title and the owner's prompts: the launch prompt and every prompt submitted through the host. */
  private task(session: Session): { title: string; text: string } {
    const chain: Session[] = [session];
    for (let hop = 0, current = session; hop < RESUME_HOPS && current.resumedFrom; hop++) {
      const earlier = this.safe(() => this.host.meta(current.resumedFrom!).session);
      if (!earlier || earlier.projectId !== session.projectId || earlier.team) break;
      chain.unshift(earlier);
      current = earlier;
    }
    const prompts: string[] = [];
    const notes: string[] = [];
    if (chain[0].resumedFrom !== undefined) notes.push("(Owner prompts of earlier sessions of this conversation were not read.)");
    for (const item of chain) {
      const opening = item.nativeArgs !== undefined ? handoffNativePrompt(item.provider, item.nativeArgs) : item.initialPrompt;
      if (opening?.trim()) prompts.push(opening);
      const scan = this.scan(item.id);
      if (scan.dropped) notes.push(`(${scan.dropped} older submitted owner prompt${scan.dropped === 1 ? " was" : "s were"} not kept.)`);
      if (!scan.complete) notes.push("(The session record could not be read to its end; later owner prompts may be missing.)");
      prompts.push(...scan.prompts);
    }
    return { title: session.title.slice(0, TITLE_LIMIT), text: taskText(prompts, notes) };
  }

  /**
   * Prompts that the owner submitted to the session through the host, read forward from where the last read
   * stopped. Only an input the host delivered carries `message`; provider output and transcripts are never read.
   */
  private scan(sessionId: string): TaskScan {
    const scan = this.scans.get(sessionId) ?? { cursor: 0, prompts: [], complete: false, dropped: 0 };
    const types = new Set(["input-result"]);
    try {
      for (let page = 0; page < TASK_SCAN_PAGES; page++) {
        const read = this.host.events(sessionId, scan.cursor, 200, types);
        for (const event of read.events)
          if (event.data.state === "delivered" && typeof event.data.message === "string" && event.data.message.trim()) scan.prompts.push(event.data.message);
        scan.cursor = read.cursor;
        scan.complete = !read.more;
        if (!read.more) break;
      }
    } catch { scan.complete = false; }
    if (scan.prompts.length > KEPT_PROMPTS) scan.dropped += scan.prompts.splice(0, scan.prompts.length - KEPT_PROMPTS).length;
    this.scans.set(sessionId, scan);
    return scan;
  }
}

/** The request id of a host answer: stable for one decision of one session, so the worker types it at most once. */
export function sessionPermissionRequestId(sessionId: string, decisionId: string): string {
  return createHash("sha256").update(`session-permission:${sessionId}:${decisionId}`).digest("hex");
}
