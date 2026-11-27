import { realpathSync } from "node:fs";
import { relative, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { accountSettingPrompt, dialogCommand, matchDestructive, oneShotPermissionOption, type AnswerResult, type Prompt, type PromptOption } from "@infinite/attention";
import { handoffNativePrompt } from "./handoff-types.js";
import { oneShotRejectOption, permissionEvidenceHash, permissionReuseKey, refusedBeforeSend } from "./team-permissions.js";
import { collectPermissionEvidence, permissionEvidenceDigest } from "./team-permission-evidence.js";
import { REJECT_CODES, requesterNotice } from "./permission-policy.js";
import type { PermissionDeliveryService, PermissionEvidence, PermissionInteractiveTarget, PermissionRequest, PermissionRequestShape } from "./permission-agent-types.js";
import type { AgentProfile, Config, Event, Project, Receipt, Session, WorkerState } from "./types.js";

export const SESSION_PERMISSION_ACTOR_LABEL = "Session permission";
const ACTION_LIMIT = 2_000;
const TITLE_LIMIT = 200;
const TASK_TEXT_LIMIT = 8_000;
const FIRST_PROMPT_LIMIT = 3_000;
const TASK_SCAN_PAGES = 16;
const RESUME_HOPS = 4;
const KEPT_PROMPTS = 64;
const HELD_RETRY_MS = 30_000;
const NOTICE_LIMIT = 2_000;

const PERSISTENT_LABEL = /always|trust|workspace|project|folder|remember|future|session|don't ask|do not ask|exit|quit/i;
const TRUST = /\btrust\b/i;
const CANONICAL_CHOICES: PromptOption[] = [{ index: 0, label: "Yes", role: "accept" }, { index: 1, label: "No", role: "reject" }];
const COMPLETE_PROBE: Prompt = {
  id: 1, kind: "permission", title: "", options: [], acceptsText: false, source: "hook", hash: "0".repeat(64),
  tool: { name: "probe", input: { probe: true }, inputComplete: true },
};
const isReject = (option: PromptOption) => option.role === "reject" || option.role === "reject-with-feedback";

export function permissionChoices(prompt: Prompt): { accept?: number; reject?: number; shape: PermissionRequestShape } {
  const accountSetting = accountSettingPrompt(prompt);
  const structural: Prompt = { ...prompt, destructive: undefined };
  const accept = oneShotPermissionOption(structural);
  const completeEvidence = oneShotPermissionOption({ ...structural, options: CANONICAL_CHOICES }) !== undefined;
  const offeredAccept = accountSetting ? undefined : oneShotPermissionOption({ ...COMPLETE_PROBE, options: [...prompt.options.filter(option => !isReject(option)), { index: -1, label: "No", role: "reject" }] });
  const oneShotReject = prompt.options.find(option => option.index === oneShotRejectOption(prompt));
  const reject = oneShotReject && !PERSISTENT_LABEL.test(oneShotReject.label) ? oneShotReject.index : undefined;
  const persistentOnly = accountSetting || offeredAccept === undefined &&
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

export function rejectTakesText(prompt: Prompt, option: number): boolean {
  return prompt.acceptsText && permissionChoices(prompt).reject === option &&
    prompt.options.some(item => item.index === option && item.role === "reject-with-feedback");
}

export function isRequesterNotice(text: unknown): text is string {
  return typeof text === "string" && text.length > 0 && text.length <= NOTICE_LIMIT && !/[\u0000-\u001f\u007f-\u009f]/.test(text) &&
    REJECT_CODES.some(code => requesterNotice(code) === text);
}

export function permissionAction(prompt: Prompt): string {
  const input = prompt.tool?.input;
  const text = typeof input?.command === "string" ? input.command
    : prompt.tool ? `${prompt.tool.name} ${JSON.stringify(input ?? {})}`
      : dialogCommand(prompt) ?? [prompt.title, prompt.detail].filter(Boolean).join("\n");
  return text.slice(0, ACTION_LIMIT);
}

export type ListedSession = Pick<Session, "id" | "projectId"> &
  Partial<Pick<Session, "team" | "workspace" | "executionLocation" | "runtime" | "headless">> &
  Pick<WorkerState, "status" | "attention"> & Partial<Pick<WorkerState, "control">>;

export function outsideRun(session: Partial<Pick<Session, "team" | "workspace" | "executionLocation" | "runtime" | "headless">>): boolean {
  return !session.team && !session.workspace && session.executionLocation !== "laptop" && !session.headless?.channel &&
    session.runtime?.transport === "pty" && !session.runtime.nativeUi;
}

export const answerableDialog = (prompt: Prompt | null | undefined): prompt is Prompt =>
  Boolean(prompt && prompt.kind === "permission" && prompt.hash && (prompt.source === "screen" || prompt.source === "hook"));

const personHolds = (control: WorkerState["control"]) => Boolean(control && control.label !== SESSION_PERMISSION_ACTOR_LABEL);

export function sessionRootOf(session: Pick<Session, "projectRoot">, project: Pick<Project, "path"> | undefined): string | undefined {
  if (!project) return undefined;
  let root: string;
  try { root = realpathSync(project.path); } catch { return undefined; }
  return session.projectRoot === undefined || session.projectRoot === root ? root : undefined;
}

const canonical = (path: string) => { try { return realpathSync(path); } catch { return undefined; } };
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); };

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
  authority?: string;
}

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

export interface SessionPermissionAnswer {
  decisionId: string;
  option: number;
  promptId: number;
  promptHash: string;
  evidenceHash: string;
  targetCwd: string;
  notice?: string;
  current?: () => boolean;
}

export interface SessionPermissionHost {
  meta(id: string): { session: Session };
  state(id: string): Promise<WorkerState>;
  events(id: string, after: number, limit: number, types?: Set<string>): { events: Event[]; cursor: number; more: boolean };
  answerSessionPermission(sessionId: string, input: SessionPermissionAnswer): Promise<Receipt & { result?: AnswerResult }>;
  invalidateSessionPermission?(sessionId: string, decisionId: string): Promise<"invalidated" | "uncertain">;
}

export interface SessionPermissionParts {
  delivery(): PermissionDeliveryService | undefined;
  serves?(projectId: string): boolean;
  authority?(projectId: string): string | undefined;
  taskEnded?(taskId: string): void;
}

type Tracked =
  | { key: string; promptId: number; phase: "building" }
  | { key: string; promptId: number; phase: "handed"; inFlight: boolean }
  | { key: string; promptId: number; phase: "owner"; retryAt?: number };
type HandedOrOwnerOutcome = { phase: "handed"; inFlight: boolean } | { phase: "owner"; retryAt?: number };
type TaskScan = { cursor: number; prompts: string[]; complete: boolean; dropped: number };

const isInFlight = (tracked: Tracked): boolean =>
  tracked.phase === "building" || tracked.phase === "handed" && tracked.inFlight;

export class SessionPermissionRequests {
  private readonly prompts = new Map<string, Tracked>();
  private readonly running = new Set<string>();
  private readonly scans = new Map<string, TaskScan>();
  private readonly unassigned = new Set<string>();
  private readonly now: () => number;

  constructor(
    private readonly config: Pick<Config, "projects" | "agents">,
    private readonly host: SessionPermissionHost,
    private readonly parts: SessionPermissionParts,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

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
      if (row.status !== "running" || row.attention?.state !== "needs-you" || !answerableDialog(prompt)) {
        if (tracked && !isInFlight(tracked)) this.prompts.delete(row.id);
        continue;
      }
      const key = `${prompt.id}:${prompt.hash}`;
      const heldUntilNow = tracked?.phase === "owner" && tracked.retryAt !== undefined && this.now() >= tracked.retryAt;
      if (tracked?.key === key && !heldUntilNow) continue;
      if (tracked && isInFlight(tracked)) continue;
      if (!delivery) { this.prompts.delete(row.id); continue; }
      if (personHolds(row.control ?? null) || !this.served(row.projectId)) {
        this.prompts.set(row.id, { key, promptId: prompt.id, phase: "owner" });
        continue;
      }
      this.prompts.set(row.id, { key, promptId: prompt.id, phase: "building" });
      void this.hand(row.id, key, delivery);
    }
    for (const [id, tracked] of this.prompts) if (!listed.has(id) && !isInFlight(tracked)) this.prompts.delete(id);
    for (const id of this.unassigned) if (!listed.has(id)) this.unassigned.delete(id);
  }

  holder(sessionId: string, promptId: number): "agent" | "owner" | "undecided" {
    const tracked = this.prompts.get(sessionId)?.promptId === promptId ? this.prompts.get(sessionId) : undefined;
    if (tracked?.phase === "building") return "undecided";
    if (tracked?.phase === "owner" || !tracked && this.unassigned.has(sessionId)) return "owner";
    const delivery = this.parts.delivery();
    if (!delivery) return "owner";
    try { return delivery.holder(sessionId, promptId); } catch { return "owner"; }
  }

  async target(sessionId: string, expectedKey?: string): Promise<PermissionInteractiveTarget | undefined> {
    const session = this.host.meta(sessionId).session;
    if (!outsideRun(session)) return undefined;
    const sessionRoot = sessionRootOf(session, this.project(session.projectId));
    const cwd = canonical(session.cwd);
    if (!sessionRoot || !cwd || !inside(sessionRoot, cwd)) return undefined;
    const state = await this.host.state(sessionId);
    const prompt = state.attention?.prompt;
    if (state.status !== "running" || personHolds(state.control ?? null) || state.attention.state !== "needs-you" ||
        !answerableDialog(prompt) || expectedKey !== undefined && `${prompt.id}:${prompt.hash}` !== expectedKey)
      return undefined;
    const request = sessionPermissionRequest({
      session, sessionRoot, prompt, task: this.task(session), model: launchModel(session, this.config.agents[session.provider]),
      authority: this.safe(() => this.parts.authority?.(session.projectId)),
    });
    const answers = new Map<string, Promise<"delivered" | "refused" | "uncertain">>();
    let read = Math.max(state.seq, this.scans.get(sessionId)?.cursor ?? 0);
    let collected: { paths: string[]; digest: string } | undefined;
    const check: PermissionInteractiveTarget["check"] = async () => {
      const live = await this.check(sessionId, request, prompt, sessionRoot, cwd);
      if (!live.ok) return live;
      const later = this.promptAfter(sessionId, read);
      if (later === "prompt") return { ok: false, stale: false, reason: "The owner submitted a prompt after the request was read." };
      if (later === "unread") return { ok: false, stale: false, reason: "The session record could not be read to its end." };
      read = later;
      if (!collected) return live;
      const again = await this.collect(sessionId, prompt, sessionRoot, cwd, collected.paths);
      return again.digest === collected.digest ? live : { ok: false, stale: true, reason: "A source file that the review read changed." };
    };
    let delivering: string | undefined;
    return {
      request,
      check,
      fence: async () => {
        if (delivering === undefined) return true;
        if (!this.host.invalidateSessionPermission) return false;
        return await this.host.invalidateSessionPermission(sessionId, delivering) === "invalidated";
      },
      answer: (option, decisionId, notice, current) => {
        const previous = answers.get(decisionId);
        if (previous) return previous;
        const result = (async () => {
          if (notice !== undefined && !isRequesterNotice(notice)) return "refused" as const;
          const live = await check();
          if (!live.ok || !(option === live.reject || option === live.accept && notice === undefined)) return "refused" as const;
          const typed = notice !== undefined && rejectTakesText(prompt, option) ? notice : undefined;
          delivering = decisionId;
          try { return await this.answer(sessionId, prompt, request.evidenceHash, cwd, option, decisionId, typed, current); }
          finally { delivering = undefined; }
        })();
        answers.set(decisionId, result);
        return result;
      },
      collect: async paths => {
        const evidence = await this.collect(sessionId, prompt, sessionRoot, cwd, paths);
        collected = { paths: Array.isArray(paths) ? [...paths] : [], digest: evidence.digest };
        return evidence;
      },
    };
  }

  private async collect(sessionId: string, prompt: Prompt, sessionRoot: string, cwd: string, paths: string[]): Promise<PermissionEvidence> {
    const nothing = (reason: string): PermissionEvidence =>
      ({ files: [], limitations: [reason], digest: permissionEvidenceDigest({ files: [], limitations: [reason] }) });
    let session: Session;
    try { session = this.host.meta(sessionId).session; }
    catch { return nothing("The session record is gone; nothing was collected."); }
    if (sessionRootOf(session, this.project(session.projectId)) !== sessionRoot || canonical(session.cwd) !== cwd)
      return nothing("The session root changed; nothing was collected.");
    const requested = (Array.isArray(paths) ? paths : []).map(path => typeof path === "string" ? resolve(sessionRoot, path) : path);
    try { return collectPermissionEvidence({ prompt, cwd, root: sessionRoot, changedPaths: [], requestedPaths: requested }); }
    catch { return nothing("The session root could not be read; nothing was collected."); }
  }

  private async hand(sessionId: string, key: string, delivery: PermissionDeliveryService) {
    let outcome: HandedOrOwnerOutcome = { phase: "owner" };
    try {
      const target = await this.target(sessionId, key);
      if (!target) return;
      const handled = delivery.handle(target);
      this.mark(sessionId, key, { phase: "handed", inFlight: true });
      const result = await handled;
      outcome = result.handled
        ? { phase: "handed", inFlight: false }
        : { phase: "owner", ...(result.held ? { retryAt: this.now() + HELD_RETRY_MS } : {}) };
    } catch { outcome = { phase: "owner" }; }
    finally { this.mark(sessionId, key, outcome); }
  }

  private mark(sessionId: string, key: string, next: HandedOrOwnerOutcome) {
    const tracked = this.prompts.get(sessionId);
    if (tracked?.key === key) this.prompts.set(sessionId, { key, promptId: tracked.promptId, ...next });
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
    if (state.attention?.state !== "needs-you" || !answerableDialog(prompt) || prompt.id !== reviewed.id || prompt.hash !== reviewed.hash ||
        permissionEvidenceHash(prompt) !== request.evidenceHash)
      return { ok: false, stale: true, reason: "The request changed or closed." };
    if (sessionRootOf(session, this.project(session.projectId)) !== sessionRoot || canonical(session.cwd) !== cwd)
      return { ok: false, stale: false, reason: "The session root changed." };
    if (personHolds(state.control ?? null)) return { ok: false, stale: false, reason: "A person holds input control of the session." };
    const { accept, reject } = permissionChoices(prompt);
    return { ok: true, ...(accept !== undefined ? { accept } : {}), ...(reject !== undefined ? { reject } : {}) };
  }

  private async answer(sessionId: string, prompt: Prompt, evidenceHash: string, cwd: string, option: number, decisionId: string, notice?: string,
    current?: () => boolean) {
    try {
      const receipt = await this.host.answerSessionPermission(sessionId, {
        decisionId, option, promptId: prompt.id, promptHash: prompt.hash!, evidenceHash, targetCwd: cwd, ...(notice !== undefined ? { notice } : {}),
        ...(current ? { current } : {}),
      });
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

  private promptAfter(sessionId: string, after: number): number | "prompt" | "unread" {
    const types = new Set(["input-result"]);
    if (!Number.isSafeInteger(after) || after < 0) return "unread";
    let cursor = after;
    try {
      for (let page = 0; page < TASK_SCAN_PAGES; page++) {
        const read = this.host.events(sessionId, cursor, 200, types);
        if (read.events.some(event => event.data.state === "delivered" && typeof event.data.message === "string" && event.data.message.trim())) return "prompt";
        cursor = read.cursor;
        if (!read.more) return cursor;
      }
    } catch {}
    return "unread";
  }

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

export function sessionPermissionRequestId(sessionId: string, decisionId: string): string {
  return createHash("sha256").update(`session-permission:${sessionId}:${decisionId}`).digest("hex");
}
