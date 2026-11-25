import { stopHandoffProcesses } from "./handoff-processes.js";
import { handoffEnvelopeSchema, handoffObjective } from "./handoff-types.js";
import { cleanTeamCheckpoint } from "./team-workspace.js";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node-pty";
import headless from "@xterm/headless";
import {
  applyLifecycle,
  applySignal,
  blockDestructive,
  claudeAgent,
  correlates,
  describeNow,
  detectPrompt,
  dropsPrompt,
  initialAttention,
  isIdleScreen,
  mapClaudeHook,
  mapCodexHook,
  mapCodexNotify,
  mapCodexOsc,
  mergeHookIntoPrompt,
  mergeScreenIntoPrompt,
  recoveryTurnEnd,
  screenDecision,
  type AnswerResult,
  type Attention,
  type Prompt,
  type Signal,
  type SignalData,
  type SignalEvent,
  detectLimit,
} from "@infinite/attention";
import { Journal, writeSealed } from "./vault.js";
import { socketPath } from "./ipc.js";
import { startHookServer, HookPayloadError, type HookAnswer, type HookReply, type HookRoute } from "./hooks.js";
import { EvidenceReader } from "./evidence/reader.js";
import { evidenceDatabasePath } from "./evidence/store.js";
import { BLACKBOARD_READ_VERSION } from "./evidence/blackboard.js";
import { createEntryRoute, ENTRY_REFUSALS } from "./team-entry-route.js";
import { sessionCredentials } from "./evidence/secret-scan.js";
import { reportRefusal, teamReportEnvelopeSchema, type TeamAssignment } from "./team-types.js";
import { missionReportEnvelopeSchema } from "./mission-types.js";
import { agentAcceptOption, isCollapsedPermissionPrompt, oneShotRejectOption, permissionEvidenceHash, oneShotPermissionOption } from "./team-permissions.js";
import { SESSION_PERMISSION_ACTOR_LABEL, isRequesterNotice, permissionChoices, rejectTakesText } from "./permission-session-requests.js";
import type { TranscriptMessage } from "./transcript.js";
import { TranscriptWatch, closesTurn } from "./transcript-watch.js";
import { drainLaunch, runFinalDrain } from "./final-drain.js";
import { buildLaunch, headlessResumeProfile } from "./launch.js";
import { channelToken } from "./permission-headless.js";
import { claudeTurnSignals, HeadlessChannelWorker } from "./permission-headless-worker.js";
import { addClaudeCodeModeToLaunchEnv, addProjectIdToLaunchEnv } from "./worker-env.js";
import { clearEgressEnvironment, workerEgressEnvironment } from "./egress.js";
import { claudeConfigPath, recordClaudeTrust } from "./workspace-trust.js";
import { TerminalSnapshots } from "./terminal-snapshot.js";
import { startNativeCodex, validateNativeCodexArgs } from "./native-codex.js";
import { startNativeOpenCode, validateNativeOpenCodeArgs } from "./native-opencode.js";
import { createExecutorTunnel, type ExecutorTunnel } from "./executor-tunnel.js";
import { JsonLineAssembler, toolFromRunLine, usageFromRunLine } from "./opencode-usage.js";
import { createHybridWorkspace } from "./hybrid-workspace.js";
import { normalizeWorkerControlRequest, teamAnswerWorkerRequestSchema, workerControlRequestSchema, workerWorkspaceExportRequestSchema,
  type Bootstrap,
  type ControlActor,
  type ControlLease,
  type Event,
  type InputControl,
  type Receipt,
  type TerminalSnapshot,
  type WorkerRequest,
  type WorkerState,
} from "./types.js";

let bootstrap = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  bootstrap += chunk;
  if (bootstrap.length > 256 * 1024) throw new Error("Invalid bootstrap");
}
const config = JSON.parse(bootstrap) as Bootstrap;
bootstrap = "";
const { session, profile, stateDir, runDir } = config;
const provider = session.provider;
const key = Buffer.from(config.key, "base64");
config.key = "";
const dir = join(stateDir, "sessions", session.id);
const journal = new Journal(join(dir, "events"), key, session.id);
if (journal.seq !== 0)
  throw new Error("Refusing to start a second process for an existing session");
const terminal = new headless.Terminal({
  cols: 120,
  rows: 32,
  scrollback: 5000,
  allowProposedApi: true,
});
const snapshots = new TerminalSnapshots(terminal);
type AnswerRequest = Extract<WorkerRequest, { op: "answer" }>;
type TeamAnswerRequest = Extract<WorkerRequest, { op: "team-answer" }>;
type TeamPermissionExpansionRequest = Extract<WorkerRequest, { op: "team-permission-expand" }>;
type SessionPermissionAnswerRequest = Extract<WorkerRequest, { op: "session-permission-answer" }>;
type DeliveryRequest = Extract<WorkerRequest, { op: "input" | "raw" | "key" | "stop" }>;
type StoredReceipt = Receipt & { digest: string; result?: AnswerResult };
const receipts = new Map<string, StoredReceipt>();
const invalidatedTeamPermissionDecisions = new Set<string>();
const invalidatedSessionPermissionDecisions = new Set<string>();
const publicReceipt = ({ digest: _digest, ...receipt }: StoredReceipt) =>
  receipt;
const initial = initialAttention(
  new Date().toISOString(),
  Boolean(config.prompt),
);
let attention: Attention = { ...initial, now: describeNow(initial, provider) };
let state: WorkerState = {
  status: "starting", seq: 0, screen: "", attention,
  capabilities: { terminalSnapshot: 1, inputControl: 1 },
  control: null,
  runtime: session.runtime ?? { id: randomUUID(), location: "local", transport: "pty" },
  ...(session.resumeNativeSession ? { nativeSession: session.resumeNativeSession } : {}),
  ...(session.workspace ? { execution: { location: "laptop", state: "connecting", cloudReady: false } as const } : {}),
};
let child: ReturnType<typeof spawn> | undefined;
let native: Awaited<ReturnType<typeof startNativeCodex>> | Awaited<ReturnType<typeof startNativeOpenCode>> | undefined;
let executor: ExecutorTunnel | undefined;
let hybrid: Awaited<ReturnType<typeof createHybridWorkspace>> | undefined;
terminal.onData((data) => {
  if (state.status === "running") child?.write(data);
});
terminal.parser.registerOscHandler(9, (data) => {
  if (provider !== "codex" || state.status !== "running") return false;
  try {
    for (const signal of mapCodexOsc(data)) {
      if (signal.kind === "prompt-open" && attention.prompt) continue;
      record(signal, "osc");
    }
  } catch {
  }
  return false;
});
let pending = "";
const usageLines = provider === "opencode" && session.team ? new JsonLineAssembler() : undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let snapshotQueue: (() => void)[] | undefined;
let snapshotBytes = 0;
let abortSnapshot: ((error: Error) => void) | undefined;
const persist = () =>
  writeSealed(join(dir, "status.sealed"), key, `${session.id}:status`, {
    ...state,
    screen: "",
    seq: journal.seq,
    workerPid: process.pid,
  });
function append(type: Event["type"], data: Event["data"]): Event {
  try {
    return journal.append(type, data);
  } catch (error) {
    recordingFailure();
    throw error;
  }
}
function flush() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  while (pending.length) {
    const data = pending.slice(0, 8192);
    pending = pending.slice(8192);
    append("output", { text: data });
  }
}

async function snapshot(): Promise<TerminalSnapshot> {
  if (state.status === "recording-error") throw new Refusal("snapshot-unavailable");
  snapshotQueue = [];
  snapshotBytes = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    flush();
    await new Promise<void>((resolve, reject) => {
      abortSnapshot = reject;
      deadline = setTimeout(() => reject(new Error("Terminal renderer is busy")), 1000);
      terminal.write("", resolve);
    });
    if ((state as WorkerState).status === "recording-error") throw new Error("Recording failed during snapshot");
    return {
      ansi: snapshots.capture(),
      seq: journal.seq,
      cols: terminal.cols,
      rows: terminal.rows,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    throw new Refusal("snapshot-unavailable");
  } finally {
    clearTimeout(deadline);
    abortSnapshot = undefined;
    const queued = snapshotQueue;
    snapshotQueue = undefined;
    for (const task of queued) task();
  }
}
function publish(next: Attention) {
  attention = { ...next, now: describeNow(next, provider) };
  state = { ...state, attention };
}
function recordingFailure() {
  state = { ...state, status: "recording-error" };
  publish(
    applyLifecycle(attention, "recording-error", new Date().toISOString()),
  );
  try {
    child?.kill("SIGSTOP");
    native?.suspend();
  } catch {
  }
}
function screen() {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let i = buffer.baseY; i < buffer.baseY + terminal.rows; i++)
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  return lines.join("\n").trimEnd();
}
const screenPrompt = () => detectPrompt(screen().split("\n"), provider);
const hashOf = (text: string) =>
  createHash("sha256").update(text).digest("hex");

function record(
  signal: Signal,
  source: SignalData["source"],
  agent?: { id: string; type: string },
): SignalEvent {
  const open = attention.prompt;
  if (open && dropsPrompt(attention, signal))
    record({ kind: "prompt-closed", promptId: open.id, reason: "resolved" }, source);
  const data = {
    ...signal,
    source,
    provider,
    ...(agent ? { agent } : {}),
  } as SignalData;
  const event = append(
    "signal",
    data as unknown as Record<string, unknown>,
  ) as unknown as SignalEvent;
  publish(applySignal(attention, event));
  if (recoveryTurnEnd(data) || (signal.kind === "notice" && signal.type === "quota_auto_resume_fired")) {
    limitEpisode = undefined;
    limitWatch = undefined;
    screenLimitSuppressed = true;
  }
  return event;
}

function hookPromptWhileOpen(
  open: Prompt,
  hook: Prompt,
  agent?: { id: string; type: string },
) {
  const mismatch = () =>
    record(
      {
        kind: "notice",
        type: "prompt-mismatch",
        message: (hook.detail ?? hook.title).slice(0, 500),
        title: hook.tool?.name,
      },
      "hook",
      agent,
    );
  if (answering === open.id) return mismatch();
  const onScreen = open.hash !== undefined ? screenPrompt() : null;
  if (onScreen && hashOf(onScreen.fingerprint) === open.hash) {
    if (correlates(hook, onScreen) && attention.state === "needs-you")
      publish({
        ...attention,
        prompt: mergeHookIntoPrompt(open, hook, onScreen),
      });
    else mismatch();
    return;
  }
  record(
    { kind: "prompt-closed", promptId: open.id, reason: "superseded" },
    "hook",
  );
  record({ kind: "prompt-open", prompt: hook }, "hook", agent);
}

function blockShown(open: Prompt) {
  if (open.hash === undefined) return false;
  const current = screenPrompt();
  return current !== null && hashOf(current.fingerprint) === open.hash;
}

let hooksReady = false;
let drainOpen = false;
let teamReportReceipt: { requestId: string; digest: string } | undefined;
const issuedCredentials = new Set<string>();
let evidenceReader: EvidenceReader | undefined;
const entryRoute = session.team?.entryTools
  ? createEntryRoute({
      team: session.team,
      own: () => ({ token: hookToken, url: hookServer?.url ?? "", credentials: [...issuedCredentials] }),
      reader: () => {
        evidenceReader ??= new EvidenceReader({ databasePath: evidenceDatabasePath(stateDir), vaultKey: key, modules: { blackboard: BLACKBOARD_READ_VERSION } });
        return evidenceReader;
      },
      running: () => state.status === "running",
      reported: () => teamReportReceipt !== undefined,
      append: (type, data) => { append(type, data); },
    })
  : undefined;
const transcriptWatch = new TranscriptWatch({
  provider,
  requestedModel: session.teamModelProfile?.model,
  onUsage: record => { append("usage", { ...record }); },
});
const MESSAGE_FIELDS = new Set(["id", "role", "text", "toolName", "ts"]);
function recordMessage(message: TranscriptMessage) {
  append("message", Object.fromEntries(Object.entries(message).filter(([key, value]) => MESSAGE_FIELDS.has(key) && value !== undefined)));
  if (state.capabilities?.transcript !== 1) {
    state = { ...state, capabilities: { ...state.capabilities, transcript: 1 } };
    persist();
  }
}
function onTranscript(body: unknown): HookReply | void {
  const reply = transcriptWatch.post(body);
  if (!reply) return;
  for (const message of reply.messages) recordMessage(message);
  return reply.secondaries ? { after: reply.after, secondaries: reply.secondaries } : { after: reply.after };
}
let handoffReceipt: string | undefined;
let handoffStopping = false;
let handoffInFlight = false;
async function onHook(route: HookRoute, body: unknown): Promise<HookReply | HookAnswer | void> {
  if (route === "permission-check" || route === "permission-request") {
    if (!permissionChannel) throw new HookPayloadError(404);
    return route === "permission-check" ? permissionChannel.check(body) : permissionChannel.request(body);
  }
  if (route === "team-entry") {
    if (!entryRoute) throw new HookPayloadError(403, ENTRY_REFUSALS["entry-tools-off"]);
    return entryRoute.handle(body);
  }
  if (route === "team-handoff") {
    const parsed = handoffEnvelopeSchema.safeParse(body);
    if (!parsed.success || !session.handoff?.policy) throw new HookPayloadError(400);
    if (parsed.data.sessionId !== session.id) throw new HookPayloadError(403);
    const digest = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");
    if (handoffReceipt) { if (handoffReceipt !== digest) throw new HookPayloadError(409); return; }
    if (state.status !== "running" || handoffInFlight) throw new HookPayloadError(409);
    handoffInFlight = true;
    try {
      handoffObjective(session.handoff.policy, parsed.data.request);
      await cleanTeamCheckpoint(session.handoff.policy.path, parsed.data.request.checkpointHead, session.handoff.policy.commandPrefix);
      if (state.status !== "running") throw new HookPayloadError(409);
      append("team-handoff", parsed.data);
      handoffReceipt = digest;
    } catch { throw new HookPayloadError(409); }
    finally { handoffInFlight = false; }
    return;
  }
  if (route === "team-report") {
    const parsed = teamReportEnvelopeSchema.safeParse(body);
    if (!parsed.success || !session.team || session.team.role === "mission-coordinator") throw new HookPayloadError(400);
    const report = parsed.data;
    if (report.runId !== session.team.runId || report.memberId !== session.team.memberId || report.revision !== session.team.revision)
      throw new HookPayloadError(403);
    const digest = createHash("sha256").update(JSON.stringify(report)).digest("hex");
    if (teamReportReceipt) {
      if (teamReportReceipt.requestId !== report.requestId || teamReportReceipt.digest !== digest) throw new HookPayloadError(409);
      return;
    }
    if (state.status !== "running") throw new HookPayloadError(409);
    const refusal = reportRefusal(session.team, report.report);
    if (refusal) throw new HookPayloadError(409, refusal);
    append("team-report", report);
    teamReportReceipt = { requestId: report.requestId, digest };
    return;
  }
  if (route === "mission-report") {
    const parsed = missionReportEnvelopeSchema.safeParse(body);
    if (!parsed.success || session.team?.role !== "mission-coordinator") throw new HookPayloadError(400);
    const report = parsed.data;
    if (report.missionId !== session.team.runId || report.memberId !== session.team.memberId || report.revision !== session.team.revision)
      throw new HookPayloadError(403);
    const digest = createHash("sha256").update(JSON.stringify(report)).digest("hex");
    if (teamReportReceipt) {
      if (teamReportReceipt.requestId !== report.requestId || teamReportReceipt.digest !== digest) throw new HookPayloadError(409);
      return;
    }
    if (state.status !== "running") throw new HookPayloadError(409);
    append("mission-report", report);
    teamReportReceipt = { requestId: report.requestId, digest };
    return;
  }
  if (route === "drain") { const started = drainOpen ? transcriptWatch.drainFinal() : undefined; return started ? { transcript: started } : undefined; }
  if (route === "transcript") return state.status === "running" || drainOpen ? onTranscript(body) : undefined;
  if (state.status !== "running") return;
  const signals = route === "claude" ? claudeTurnSignals(mapClaudeHook(body), () => permissionChannel?.takeContinue() === true) : route === "codex" ? mapCodexHook(body) : mapCodexNotify(body);
  const linkOnly = route === "codex-notify" && !config.attention.hooks.codex;
  const agent = route === "claude" ? claudeAgent(body) : undefined;
  const b = body as Record<string, unknown>;
  const event =
    typeof b.hook_event_name === "string"
      ? b.hook_event_name
      : typeof b.type === "string"
        ? b.type
        : route;
  const hookProvider = provider === "demo" ? "claude" : provider;
  const nativeId = !b.agent_id && (
    ((hookProvider === "claude" && route === "claude") || (hookProvider === "codex" && route === "codex")) &&
      typeof b.hook_event_name === "string"
      ? b.session_id
      : hookProvider === "codex" && route === "codex-notify" && b.type === "agent-turn-complete"
        ? b["thread-id"]
        : undefined
  );
  if (typeof nativeId === "string" && nativeId.length >= 1 && nativeId.length <= 200 &&
      !/[\x00-\x20\x7f]/.test(nativeId) && nativeId !== state.nativeSession?.id) {
    state = { ...state, nativeSession: { id: nativeId, source: "hook" } };
    persist();
  }
  const path = b.transcript_path;
  const transcriptPath = nativeId !== undefined && typeof path === "string" && path.startsWith("/") && path.endsWith(".jsonl") && path.length <= 4096 && !/[\x00-\x1f]/.test(path)
    ? path
    : undefined;
  const started = transcriptWatch.hook({
    subagent: b.agent_id !== undefined,
    turnEnd: closesTurn(signals, event),
    endOnly: linkOnly,
    sessionEnd: event === "SessionEnd",
    ...(transcriptPath !== undefined ? { transcript: { path: transcriptPath, provider: route === "claude" ? "claude" : "codex" } } : {}),
  });
  let reply: HookReply | void = started ? { transcript: started } : undefined;
  if (!hooksReady) {
    hooksReady = true;
    if (!linkOnly) record({ kind: "hooks-ready", event: event.slice(0, 60) }, "hook");
  }
  for (const signal of linkOnly ? [] : signals) {
    if (signal.kind === "prompt-closed") {
      const open = attention.prompt;
      if (!open || answering === open.id || blockShown(open)) continue;
      record({ ...signal, promptId: open.id }, "hook", agent);
      continue;
    }
    if (signal.kind === "prompt-open" && attention.prompt) {
      if (route === "claude" && event === "Notification") continue;
      hookPromptWhileOpen(attention.prompt, signal.prompt, agent);
      continue;
    }
    if (signal.kind === "provider-limit") recordLimitFromHook(signal, agent);
    else record(signal, "hook", agent);
  }
  return reply;
}

let lastOutputAt = Date.now();
let outputSinceCheck = false;
let missCount = 0;
let answering: number | undefined;

let limitWatch: { source: "hook" | "screen"; firstAt: number; checks: number; corroborated: boolean } | undefined;
let screenLimitSuppressed = false;
let limitEpisode: { single?: "hook" | "screen"; corroborated: boolean; misses: number; resetsAt?: string } | undefined;
type LimitSignal = Extract<Signal, { kind: "provider-limit" }>;
function recordLimit(signal: LimitSignal, source: SignalData["source"], agent?: { id: string; type: string }) {
  const episode = (limitEpisode ??= { corroborated: false, misses: 0 });
  episode.misses = 0;
  episode.resetsAt = signal.resetsAt ?? episode.resetsAt;
  if (episode.resetsAt) signal = { ...signal, resetsAt: episode.resetsAt };
  if (signal.confidence === "corroborated") {
    if (episode.corroborated) return;
    episode.corroborated = true;
  } else {
    if (episode.single || episode.corroborated) return;
    episode.single = source === "hook" ? "hook" : "screen";
  }
  record(signal, source, agent);
}
function recordLimitFromHook(signal: LimitSignal, agent?: { id: string; type: string }) {
  if (signal.confidence === "corroborated") {
    limitWatch = undefined;
    recordLimit(signal, "hook", agent);
    return;
  }
  if (limitEpisode?.single === "screen" && !limitEpisode.corroborated) {
    limitWatch = undefined;
    recordLimit({ ...signal, confidence: "corroborated" }, "hook", agent);
    return;
  }
  const fresh = !limitEpisode?.single && !limitEpisode?.corroborated;
  recordLimit(signal, "hook", agent);
  if (fresh) limitWatch = { source: "hook", firstAt: Date.now(), checks: 0, corroborated: false };
}
function watchLimit(lines: string[], nowMs: number, freshOutput: boolean) {
  const found = detectLimit(lines, provider, new Date(nowMs));
  const watch = limitWatch;
  if (!found) {
    screenLimitSuppressed = false;
    if (watch?.source === "screen" || (watch && ++watch.checks > 2)) limitWatch = undefined;
    if (!limitWatch && limitEpisode && ++limitEpisode.misses >= 3) limitEpisode = undefined;
    return;
  }
  if (screenLimitSuppressed) return;
  if (limitEpisode) limitEpisode.misses = 0;
  const observed = { kind: "provider-limit" as const, limit: found.limit, message: found.message, ...(found.resetsAt ? { resetsAt: found.resetsAt } : {}) };
  if (watch?.source === "hook") {
    limitWatch = undefined;
    recordLimit({ ...observed, confidence: "corroborated" }, "screen");
    return;
  }
  if (!watch) {
    recordLimit({ ...observed, confidence: "single-source" }, "screen");
    if (provider === "codex") limitWatch = { source: "screen", firstAt: nowMs, checks: 1, corroborated: false };
    return;
  }
  if (freshOutput) {
    limitWatch = { source: "screen", firstAt: nowMs, checks: 1, corroborated: watch.corroborated };
    return;
  }
  if (watch.corroborated) return;
  watch.checks++;
  if (watch.checks >= 3 && nowMs - watch.firstAt >= config.attention.limitConfirmMs) {
    recordLimit({ ...observed, confidence: "corroborated" }, "screen");
    watch.corroborated = true;
  }
}

function checkScreen() {
  if (state.status !== "running" || permissionChannel?.waiting()) return;
  try {
    const lines = screen().split("\n");
    const detected = detectPrompt(lines, provider);
    const nowMs = Date.now();
    const at = new Date(nowMs).toISOString();
    const idle =
      !outputSinceCheck &&
      nowMs - lastOutputAt >= config.attention.idleAfterMs &&
      isIdleScreen(lines, provider);
    const freshOutput =
      outputSinceCheck && lastOutputAt > Date.parse(attention.since);
    const outputThisCheck = outputSinceCheck;
    outputSinceCheck = false;
    watchLimit(lines, nowMs, outputThisCheck);
    let decision = screenDecision(attention, detected, idle, freshOutput, at);
    const open = attention.prompt;
    const replaced =
      detected !== null &&
      open?.hash !== undefined &&
      open.options.length > 0 &&
      hashOf(detected.fingerprint) !== open.hash;
    if (open && (decision.kind === "close" || replaced) && answering !== open.id) {
      if (++missCount >= 2) {
        missCount = 0;
        record(
          {
            kind: "prompt-closed",
            promptId: open.id,
            reason: replaced ? "superseded" : "vanished",
          },
          "screen",
        );
        if (replaced)
          decision = screenDecision(attention, detected, idle, freshOutput, at);
      }
    } else missCount = 0;
    if (decision.kind === "merge" && open && !correlates(open, decision.merge)) {
      record(
        { kind: "prompt-closed", promptId: open.id, reason: "superseded" },
        "screen",
      );
      decision = screenDecision(attention, detected, idle, freshOutput, at);
    }
    switch (decision.kind) {
      case "open": {
        const { fingerprint, ...rest } = decision.open;
        record({ kind: "prompt-open", prompt: { ...rest, id: 0, hash: hashOf(fingerprint), destructive: blockDestructive(rest) } }, "screen");
        break;
      }
      case "merge":
        if (attention.state === "needs-you" && attention.prompt) {
          const merged = mergeScreenIntoPrompt(attention.prompt, decision.merge, hashOf(decision.merge.fingerprint));
          publish({ ...attention, prompt: merged });
          record({ kind: "notice", type: "prompt-merged", promptId: merged.id, title: merged.title, ...(merged.detail !== undefined ? { detail: merged.detail } : {}) }, "screen");
        }
        break;
      case "idle":
        if (!native) {
          const same = attention.state === decision.idle;
          publish({ ...attention, prompt: undefined, lastTool: undefined, state: decision.idle, since: same ? attention.since : at, source: same ? attention.source : "screen" });
        }
        break;
      case "working":
        if (!native) publish({ ...attention, prompt: undefined, state: "working", since: at, source: "screen" });
        break;
      case "close":
      case "none":
        break;
    }
    if (describeNow(attention, provider) !== attention.now) publish(attention);
  } catch {
  }
}
setInterval(checkScreen, 1000).unref();

let serial: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => T | Promise<T>): Promise<T> {
  const run = serial.then(task);
  serial = run.catch(() => {});
  return run;
}

const CONTROL_TTL_MS = 30_000;
let controller: { actorId: string; lease: ControlLease } | null = null;
let controlChangeGeneration = 0;
function currentControl(): ControlLease | null {
  if (controller && controller.lease.expiresAt <= Date.now()) {
    controller = null;
    state = { ...state, control: null };
    persist();
  }
  return controller?.lease ?? null;
}
function validActor(actor: ControlActor | undefined): actor is ControlActor {
  return Boolean(actor && typeof actor.id === "string" && actor.id.length >= 1 && actor.id.length <= 128 &&
    typeof actor.label === "string" && actor.label.length >= 1 && actor.label.length <= 120 &&
    !/[\x00-\x1f\x7f]/.test(actor.id + actor.label));
}
function validateControl(request: InputControl) {
  if ((request.actor !== undefined && !validActor(request.actor)) ||
    (request.leaseId !== undefined && (typeof request.leaseId !== "string" || request.leaseId.length > 80)))
    throw new Error("Invalid session control");
}
function changeControl(rawRequest: Extract<WorkerRequest, { op: "control" }>): ControlLease | null {
  const normalized = normalizeWorkerControlRequest(rawRequest);
  if ((normalized.action === "renew" || normalized.action === "release") && normalized.leaseId === undefined && validActor(normalized.actor) && (normalized as { takeover?: unknown }).takeover === undefined) throw new Refusal("control-lost");
  const parsed = workerControlRequestSchema.safeParse(normalized); if (!parsed.success) throw new Error("Invalid session control"); const request = parsed.data;
  const active = currentControl();
  const owns = active && controller?.actorId === request.actor.id && active.id === request.leaseId;
  const reconnecting = active && controller?.actorId === request.actor.id && request.leaseId === undefined;
  if (request.action === "claim") {
    if (active && !owns && !reconnecting && !request.takeover) throw new Refusal("control-busy");
    if (!active || reconnecting || request.takeover) {
      controller = {
        actorId: request.actor.id,
        lease: { id: randomUUID(), label: request.actor.label, expiresAt: Date.now() + CONTROL_TTL_MS },
      };
      controlChangeGeneration++;
    } else controller!.lease.expiresAt = Date.now() + CONTROL_TTL_MS;
  } else {
    if (!owns) throw new Refusal("control-lost");
    if (request.action === "release") {
      controller = null;
      controlChangeGeneration++;
    } else controller!.lease.expiresAt = Date.now() + CONTROL_TTL_MS;
  }
  state = { ...state, control: controller?.lease ?? null };
  persist();
  return state.control!;
}
function checkControl(request: InputControl) {
  validateControl(request);
  const active = currentControl();
  if (request.leaseId !== undefined) {
    if (!request.actor || !active || active.id !== request.leaseId || controller?.actorId !== request.actor.id)
      throw new Refusal("control-lost");
  } else if (active) throw new Refusal("control-busy");
}
function refreshControl(request: InputControl) {
  if (currentControl() && controller && request.leaseId === controller.lease.id && request.actor?.id === controller.actorId)
    controller.lease.expiresAt = Date.now() + CONTROL_TTL_MS;
}
function requestDigest(request: (DeliveryRequest | AnswerRequest | TeamAnswerRequest | TeamPermissionExpansionRequest)) {
  const { actor: _actor, leaseId: _leaseId, ...input } = request;
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function deliver(
  request: DeliveryRequest,
): Receipt {
  const digest = requestDigest(request);
  const previous = receipts.get(request.requestId);
  if (previous) {
    if (previous.digest !== digest)
      throw new Error("Request ID already belongs to different input");
    return publicReceipt(previous);
  }
  checkControl(request);
  if (handoffReceipt && request.op !== "stop") throw new Error("This session yielded to a team; further input is disabled");
  if (permissionChannel?.waiting() && request.op !== "stop") throw new Refusal("prompt-open");
  if (state.status !== "running" || !child)
    throw new Error("Session is not running");
  if (
    request.op === "input" &&
    request.force !== true &&
    attention.state === "needs-you" &&
    attention.prompt &&
    blockShown(attention.prompt)
  )
    throw new Refusal("prompt-open");
  if (
    request.op === "input" &&
    request.text.includes("\n") &&
    !terminal.modes.bracketedPasteMode
  )
    throw new Error(
      "This terminal has not enabled multiline paste. Send one line or use native attach.",
    );
  flush();
  const intent = append("input-intent", { ...request });
  const receipt: StoredReceipt = {
    requestId: request.requestId,
    state: "uncertain",
    seq: intent.seq,
    digest,
  };
  receipts.set(request.requestId, receipt);
  let retireWaiting = false;
  if (request.op === "input") {
    child.write(
      terminal.modes.bracketedPasteMode
        ? `\x1b[200~${request.text}\x1b[201~`
        : request.text,
    );
    if (request.submit) child.write("\r");
  } else if (request.op === "raw") child.write(request.text);
  else if (request.op === "key") {
    child.write(
      {
        interrupt: "\x03",
        enter: "\r",
        escape: "\x1b",
        up: "\x1b[A",
        down: "\x1b[B",
        tab: "\t",
      }[request.key],
    );
  } else if (permissionChannel?.waiting()) retireWaiting = true;
  else {
    transcriptWatch.stopRequested();
    child.kill("SIGTERM");
  }
  const result = append("input-result", {
    requestId: request.requestId,
    state: "delivered",
    ...(request.op === "input" && request.submit ? { message: request.text } : {}),
  });
  receipt.state = "delivered";
  receipt.seq = result.seq;
  refreshControl(request);
  if (retireWaiting) permissionChannel!.retire("stopped");
  return publicReceipt(receipt);
}

type RefusalCode =
  | "prompt-open"
  | "prompt-changed"
  | "unsupported"
  | "invalid-option"
  | "text-not-accepted"
  | "control-busy"
  | "control-lost"
  | "snapshot-unavailable";
class Refusal extends Error {
  constructor(readonly code: RefusalCode) {
    super(code);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arrow = (key: "up" | "down") =>
  (terminal.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[") +
  (key === "up" ? "A" : "B");

async function answer(
  request: AnswerRequest | TeamAnswerRequest,
): Promise<Receipt & { result?: AnswerResult }> {
  const teamRequest = request.op === "team-answer" ? request : undefined;
  const answerText = request.op === "answer" ? request.text : teamRequest?.choice === "reject" ? teamRequest.text : undefined;
  const digest = requestDigest(request);
  const previous = receipts.get(request.requestId);
  if (previous) {
    if (previous.digest !== digest || (previous.result === undefined && !teamRequest))
      throw new Error("Request ID already belongs to different input");
    return publicReceipt(previous);
  }
  if (teamRequest) {
    if (invalidatedTeamPermissionDecisions.has(teamRequest.decisionId)) throw new Refusal("unsupported");
    const actual = session.team;
    const assigned = teamRequest.assignment;
    let cwd: string;
    try { cwd = realpathSync(session.cwd); }
    catch { throw new Refusal("unsupported"); }
    if (!actual || teamRequest.targetSessionId !== session.id ||
        actual.runId !== assigned.runId || actual.memberId !== assigned.memberId ||
        actual.revision !== assigned.revision || actual.role !== assigned.role || actual.taskId !== assigned.taskId ||
        teamRequest.targetCwd !== cwd ||
        session.runtime?.nativeUi || session.runtime?.transport !== "pty")
      throw new Refusal("unsupported");
    if (teamRequest.actor.id !== `team-permission:${teamRequest.decisionId}` ||
        teamRequest.actor.label !== "Team permission" || !/^[a-f0-9-]{36}$/i.test(teamRequest.decisionId) ||
        teamRequest.choice === undefined && !/^[a-f0-9-]{36}$/i.test(teamRequest.coordinatorMemberId ?? "") ||
        !/^[a-f0-9]{64}$/i.test(teamRequest.policyHash) ||
        !Number.isFinite(Date.parse(teamRequest.expiresAt)) || Date.parse(teamRequest.expiresAt) <= Date.now())
      throw new Refusal("prompt-changed");
    checkControl(teamRequest);
  } else if (request.op === "answer" && !request.missionManaged) checkControl(request);
  const acceptedControlGeneration = controlChangeGeneration;
  const pty = child;
  if (state.status !== "running" || !pty)
    throw new Error("Session is not running");
  const prompt = attention.prompt;
  if (
    attention.state !== "needs-you" ||
    !prompt ||
    prompt.id !== request.promptId ||
    !prompt.hash
  )
    throw new Refusal("prompt-changed");
  const current = screenPrompt();
  if (!current || hashOf(current.fingerprint) !== prompt.hash)
    throw new Refusal("prompt-changed");
  const delegatedRoles = teamRequest?.choice === "reject" ? ["reject", "reject-with-feedback"] : ["accept"];
  const delegatedOption = !teamRequest ? undefined : teamRequest.choice === "reject" ? oneShotRejectOption(prompt)
    : teamRequest.choice === "accept" ? agentAcceptOption(prompt) : oneShotPermissionOption(prompt);
  const showsReviewed = (now: ReturnType<typeof screenPrompt>) => Boolean(teamRequest && now &&
    hashOf(now.fingerprint) === prompt.hash && now.title === prompt.title && now.detail === prompt.detail &&
    (prompt.tool || now.pinned) && now.options.some(option => option.index === teamRequest.option && delegatedRoles.includes(option.role)));
  if (teamRequest && (teamRequest.promptId !== prompt.id || teamRequest.promptHash !== prompt.hash ||
      teamRequest.evidenceHash !== permissionEvidenceHash(prompt) ||
      delegatedOption !== teamRequest.option || !showsReviewed(current)))
    throw new Refusal("prompt-changed");
  if (prompt.multiSelect || current.multiSelect)
    throw new Refusal("unsupported");
  if (request.option !== undefined && !current.options.some(option => option.index === request.option))
    throw new Refusal("invalid-option");
  const yesNo = current.kind === "yes-no";
  if (teamRequest && yesNo) throw new Refusal("unsupported");
  const feedback = current.options.find(
    (o) => o.role === "reject-with-feedback",
  );
  if (
    answerText !== undefined &&
    (!prompt.acceptsText ||
      yesNo ||
      !feedback ||
      (request.option !== undefined && request.option !== feedback.index) ||
      (answerText.includes("\n") && !terminal.modes.bracketedPasteMode))
  )
    throw new Refusal("text-not-accepted");
  const chosen =
    request.option !== undefined ? current.options[request.option] : feedback;
  if (!chosen) throw new Refusal("invalid-option");
  const from = current.highlighted ?? 0;
  const keys: string[] = yesNo
    ? [chosen.role === "accept" ? "y" : "n", "enter"]
    : [
        ...Array<string>(Math.abs(chosen.index - from)).fill(
          chosen.index > from ? "down" : "up",
        ),
        "enter",
      ];
  flush();
  const intent = append("input-intent", {
    op: "answer",
    requestId: request.requestId,
    promptId: prompt.id,
    option: chosen.index,
    keys,
    ...(answerText !== undefined ? { text: answerText } : {}),
    ...(teamRequest ? { delegation: {
      decisionId: teamRequest.decisionId,
      ...(teamRequest.coordinatorMemberId ? { coordinatorMemberId: teamRequest.coordinatorMemberId } : {}),
      ...(teamRequest.choice ? { choice: teamRequest.choice } : {}),
      targetSessionId: teamRequest.targetSessionId,
      assignment: teamRequest.assignment,
      targetCwd: teamRequest.targetCwd,
      expiresAt: teamRequest.expiresAt,
      policyHash: teamRequest.policyHash,
      promptHash: teamRequest.promptHash,
      evidenceHash: teamRequest.evidenceHash,
    } } : {}),
  });
  const receipt: StoredReceipt = {
    requestId: request.requestId,
    state: "uncertain",
    seq: intent.seq,
    digest,
    ...(teamRequest ? {} : { result: "refused" as AnswerResult }),
  };
  receipts.set(request.requestId, receipt);
  const unchanged = () => {
    const now = screenPrompt();
    return now && hashOf(now.fingerprint) === prompt.hash ? now : null;
  };
  const beforeWrite = (reviewedScreen = true) => {
    if (teamRequest && invalidatedTeamPermissionDecisions.has(teamRequest.decisionId)) throw new Refusal("control-lost");
    if (teamRequest && Date.parse(teamRequest.expiresAt) <= Date.now()) throw new Refusal("prompt-changed");
    if (teamRequest) checkControl(teamRequest);
    else if (controlChangeGeneration !== acceptedControlGeneration) throw new Refusal("control-lost");
    if (state.status !== "running" || child !== pty) throw new Refusal("prompt-changed");
    if (teamRequest && (!session.team || session.team.runId !== teamRequest.assignment.runId ||
        session.team.memberId !== teamRequest.assignment.memberId || session.team.revision !== teamRequest.assignment.revision ||
        session.team.role !== teamRequest.assignment.role || session.team.taskId !== teamRequest.assignment.taskId))
      throw new Refusal("unsupported");
    if (teamRequest && reviewedScreen && !showsReviewed(screenPrompt())) throw new Refusal("prompt-changed");
    if (teamRequest && !reviewedScreen && screenPrompt()) throw new Refusal("prompt-changed");
  };
  answering = prompt.id;
  try {
    let result: AnswerResult = "still-open";
    if (yesNo) {
      beforeWrite();
      pty.write(keys[0]);
      await sleep(40);
      beforeWrite();
      pty.write("\r");
    } else {
      for (const key of keys.slice(0, -1)) {
        beforeWrite();
        pty.write(arrow(key as "up" | "down"));
        await sleep(40);
      }
      let onTarget = false;
      for (const until = Date.now() + 500; ; ) {
        await sleep(40);
        beforeWrite();
        const now = unchanged();
        if (!now) break;
        if (now.highlighted === undefined || now.highlighted === chosen.index) {
          onTarget = true;
          break;
        }
        if (Date.now() >= until) break;
      }
      if (onTarget) { beforeWrite(); pty.write("\r"); }
      else result = "changed";
    }
    if (result !== "changed")
      for (const until = Date.now() + 1500; Date.now() < until; ) {
        await sleep(100);
        if (!unchanged()) {
          result = "closed";
          break;
        }
      }
    if (result === "closed") {
      if (attention.prompt?.id === prompt.id)
        record(
          {
            kind: "prompt-closed",
            promptId: prompt.id,
            reason: "answered-here",
            label: chosen.label,
          },
          "host",
        );
      if (answerText !== undefined) {
        await sleep(150);
        beforeWrite(false);
        pty.write(
          terminal.modes.bracketedPasteMode
            ? `\x1b[200~${answerText}\x1b[201~`
            : answerText,
        );
        beforeWrite(false);
        pty.write("\r");
      }
    }
    record(
      {
        kind: "answer",
        promptId: prompt.id,
        requestId: request.requestId,
        option: { index: chosen.index, label: chosen.label },
        text: answerText !== undefined,
        result,
      },
      "host",
    );
    const done = append("input-result", {
      requestId: request.requestId,
      state: "delivered",
      result,
    });
    receipt.state = "delivered";
    receipt.seq = done.seq;
    receipt.result = result;
    refreshControl(request);
    return publicReceipt(receipt);
  } catch (error) {
    if (teamRequest) return publicReceipt(receipt);
    throw error;
  } finally {
    answering = undefined;
  }
}

function validTeamPermissionExpansion(request: TeamPermissionExpansionRequest) {
  const rawAssignment: unknown = request.assignment;
  const expected: unknown = request.expected;
  if (!rawAssignment || typeof rawAssignment !== "object" || Array.isArray(rawAssignment) ||
      !expected || typeof expected !== "object" || Array.isArray(expected)) return false;
  const assignment = rawAssignment as TeamAssignment;
  const screen = expected as TeamPermissionExpansionRequest["expected"];
  return typeof request.requestId === "string" && /^[a-f0-9-]{36}$/i.test(request.requestId) &&
    request.targetSessionId === session.id &&
    /^[a-f0-9-]{36}$/i.test(assignment.runId) && /^[a-f0-9-]{36}$/i.test(assignment.memberId) &&
    Number.isInteger(assignment.revision) && assignment.revision > 0 &&
    ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "intent-checker", "evaluator", "judge"].includes(assignment.role) &&
    (assignment.taskId === undefined || typeof assignment.taskId === "string") &&
    Number.isInteger(screen.promptId) && screen.promptId >= 1 &&
    /^[a-f0-9]{64}$/i.test(screen.promptHash) && /^[a-f0-9]{64}$/i.test(screen.evidenceHash) &&
    typeof screen.targetCwd === "string" && screen.targetCwd.length > 0 && screen.targetCwd.length <= 4096 &&
    typeof screen.expiresAt === "string" && Number.isFinite(Date.parse(screen.expiresAt)) &&
    validActor(request.actor) && typeof request.leaseId === "string" && request.leaseId.length > 0 && request.leaseId.length <= 80;
}

function expandTeamPermission(request: TeamPermissionExpansionRequest): Receipt {
  const digest = requestDigest(request);
  const previous = receipts.get(request.requestId);
  if (previous) {
    if (previous.digest !== digest) throw new Error("Request ID already belongs to different input");
    return publicReceipt(previous);
  }
  if (!validTeamPermissionExpansion(request)) throw new Error("Invalid collapsed permission expansion request");

  const assigned = request.assignment;
  const expected = request.expected;
  const sameAssignment = (left: TeamAssignment | undefined) => Boolean(left &&
    left.runId === assigned.runId && left.memberId === assigned.memberId && left.revision === assigned.revision &&
    left.role === assigned.role && left.taskId === assigned.taskId);
  const assertCurrent = (pty: ReturnType<typeof spawn> | undefined) => {
    if (state.status !== "running" || !pty || child !== pty || handoffReceipt ||
        provider !== "codex" || session.runtime?.transport !== "pty" || session.runtime.nativeUi ||
        !sameAssignment(session.team) || request.targetSessionId !== session.id)
      throw new Refusal("unsupported");
    let cwd: string;
    try { cwd = realpathSync(session.cwd); }
    catch { throw new Refusal("unsupported"); }
    if (cwd !== expected.targetCwd) throw new Refusal("unsupported");
    if (Date.parse(expected.expiresAt) <= Date.now()) throw new Refusal("prompt-changed");
    if (request.actor.id !== `team-permission-expand:${request.requestId}` ||
        request.actor.label !== "Team permission display expansion")
      throw new Refusal("unsupported");
    checkControl(request);

    const prompt = attention.prompt;
    if (attention.state !== "needs-you" || !prompt || prompt.id !== expected.promptId ||
        prompt.hash !== expected.promptHash || permissionEvidenceHash(prompt) !== expected.evidenceHash)
      throw new Refusal("prompt-changed");
    const current = screenPrompt();
    if (!current || hashOf(current.fingerprint) !== expected.promptHash || current.title !== prompt.title ||
        current.detail !== prompt.detail ||
        JSON.stringify(current.options) !== JSON.stringify(prompt.options) || current.pinned !== true ||
        Boolean(current.multiSelect) !== Boolean(prompt.multiSelect))
      throw new Refusal("prompt-changed");
    const visible: Prompt = {
      id: prompt.id, kind: current.kind, title: current.title, detail: current.detail,
      options: current.options, acceptsText: current.acceptsText,
      multiSelect: Boolean(prompt.multiSelect) || current.multiSelect, pinned: current.pinned,
      source: "screen", hash: hashOf(current.fingerprint),
    };
    if (!isCollapsedPermissionPrompt(visible)) throw new Refusal("prompt-changed");
  };

  const pty = child;
  assertCurrent(pty);
  flush();
  assertCurrent(pty);
  const prompt = attention.prompt!;
  const intent = append("input-intent", {
    op: "team-permission-expand", requestId: request.requestId, promptId: prompt.id,
    promptHash: expected.promptHash, evidenceHash: expected.evidenceHash,
    targetSessionId: request.targetSessionId, assignment: request.assignment,
    targetCwd: expected.targetCwd, expiresAt: expected.expiresAt,
  });
  const receipt: StoredReceipt = { requestId: request.requestId, state: "uncertain", seq: intent.seq, digest };
  receipts.set(request.requestId, receipt);
  try {
    assertCurrent(pty);
    pty!.write("\x01");
    append("input-result", { requestId: request.requestId, state: "delivered", op: "team-permission-expand" });
    receipt.state = "delivered";
    receipt.seq = journal.seq;
    refreshControl(request);
    return publicReceipt(receipt);
  } catch (error) {
    if (error instanceof Refusal) return publicReceipt(receipt);
    throw error;
  }
}

function validSessionPermissionAnswer(request: SessionPermissionAnswerRequest) {
  return typeof request.requestId === "string" && request.requestId.length >= 1 && request.requestId.length <= 80 &&
    typeof request.decisionId === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(request.decisionId) &&
    request.targetSessionId === session.id &&
    typeof request.targetCwd === "string" && request.targetCwd.length > 0 && request.targetCwd.length <= 4096 &&
    Number.isInteger(request.promptId) && request.promptId >= 1 &&
    typeof request.promptHash === "string" && /^[a-f0-9]{64}$/i.test(request.promptHash) &&
    typeof request.evidenceHash === "string" && /^[a-f0-9]{64}$/i.test(request.evidenceHash) &&
    Number.isInteger(request.option) && request.option >= 0 && validActor(request.actor) &&
    (request.text === undefined || isRequesterNotice(request.text)) &&
    typeof request.leaseId === "string" && request.leaseId.length > 0 && request.leaseId.length <= 80;
}

async function answerSessionPermission(request: SessionPermissionAnswerRequest): Promise<Receipt & { result?: AnswerResult }> {
  const { actor: _actor, leaseId: _leaseId, ...input } = request;
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const previous = receipts.get(request.requestId);
  if (previous) {
    if (previous.digest !== digest) throw new Error("Request ID already belongs to different input");
    return publicReceipt(previous);
  }
  const pty = child;
  const assertTarget = () => {
    if (session.team || request.targetSessionId !== session.id || handoffReceipt ||
        session.runtime?.nativeUi || session.runtime?.transport !== "pty")
      throw new Refusal("unsupported");
    if (invalidatedSessionPermissionDecisions.has(request.decisionId)) throw new Refusal("control-lost");
    let cwd: string;
    try { cwd = realpathSync(session.cwd); }
    catch { throw new Refusal("unsupported"); }
    if (cwd !== request.targetCwd ||
        request.actor.id !== `session-permission:${request.decisionId}` || request.actor.label !== SESSION_PERMISSION_ACTOR_LABEL)
      throw new Refusal("unsupported");
    checkControl(request);
    if (state.status !== "running" || !pty || child !== pty) throw new Refusal("prompt-changed");
  };
  assertTarget();
  const prompt = attention.prompt;
  if (attention.state !== "needs-you" || !prompt || prompt.id !== request.promptId || prompt.hash !== request.promptHash ||
      permissionEvidenceHash(prompt) !== request.evidenceHash)
    throw new Refusal("prompt-changed");
  if (prompt.multiSelect) throw new Refusal("unsupported");
  const choices = permissionChoices(prompt);
  const role = request.option === choices.accept ? "accept" : request.option === choices.reject ? "reject" : undefined;
  if (!role) throw new Refusal("invalid-option");
  const text = request.text;
  if (text !== undefined && (role !== "reject" || !rejectTakesText(prompt, request.option))) throw new Refusal("text-not-accepted");
  const showsReviewed = (now: ReturnType<typeof screenPrompt>) => Boolean(now &&
    hashOf(now.fingerprint) === prompt.hash && now.title === prompt.title && now.detail === prompt.detail &&
    (prompt.tool || now.pinned) && !now.multiSelect && (text === undefined || now.acceptsText) &&
    now.options.some(option => option.index === request.option && (role === "accept" ? option.role === "accept"
      : text !== undefined ? option.role === "reject-with-feedback" : option.role === "reject" || option.role === "reject-with-feedback")));
  const current = screenPrompt();
  if (!current || !showsReviewed(current)) throw new Refusal("prompt-changed");
  if (current.kind === "yes-no") throw new Refusal("unsupported");
  const chosen = current.options.find(option => option.index === request.option)!;
  const from = current.highlighted ?? 0;
  const keys = [...Array<string>(Math.abs(chosen.index - from)).fill(chosen.index > from ? "down" : "up"), "enter"];
  flush();
  const intent = append("input-intent", {
    op: "session-permission-answer", requestId: request.requestId, promptId: prompt.id, option: chosen.index, keys,
    ...(text !== undefined ? { text } : {}),
    delegation: { decisionId: request.decisionId, targetSessionId: request.targetSessionId, targetCwd: request.targetCwd,
      promptHash: request.promptHash, evidenceHash: request.evidenceHash },
  });
  const receipt: StoredReceipt = { requestId: request.requestId, state: "uncertain", seq: intent.seq, digest };
  receipts.set(request.requestId, receipt);
  const unchanged = () => {
    const now = screenPrompt();
    return now && hashOf(now.fingerprint) === prompt.hash ? now : null;
  };
  const beforeWrite = () => {
    assertTarget();
    if (!showsReviewed(screenPrompt())) throw new Refusal("prompt-changed");
  };
  answering = prompt.id;
  try {
    let result: AnswerResult = "still-open";
    for (const key of keys.slice(0, -1)) {
      beforeWrite();
      pty!.write(arrow(key as "up" | "down"));
      await sleep(40);
    }
    let onTarget = false;
    for (const until = Date.now() + 500; ; ) {
      await sleep(40);
      beforeWrite();
      const now = unchanged();
      if (!now) break;
      if (now.highlighted === undefined || now.highlighted === chosen.index) { onTarget = true; break; }
      if (Date.now() >= until) break;
    }
    if (onTarget) { beforeWrite(); pty!.write("\r"); }
    else result = "changed";
    if (result !== "changed")
      for (const until = Date.now() + 1500; Date.now() < until; ) {
        await sleep(100);
        if (!unchanged()) { result = "closed"; break; }
      }
    if (result === "closed" && attention.prompt?.id === prompt.id)
      record({ kind: "prompt-closed", promptId: prompt.id, reason: "answered-here", label: chosen.label }, "host");
    if (result === "closed" && text !== undefined) {
      await sleep(150);
      const noDialog = () => { assertTarget(); if (screenPrompt()) throw new Refusal("prompt-changed"); };
      noDialog();
      pty!.write(terminal.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text);
      noDialog();
      pty!.write("\r");
    }
    record({ kind: "answer", promptId: prompt.id, requestId: request.requestId, option: { index: chosen.index, label: chosen.label }, text: text !== undefined, result }, "host");
    const done = append("input-result", { requestId: request.requestId, state: "delivered", result });
    receipt.state = "delivered";
    receipt.seq = done.seq;
    receipt.result = result;
    refreshControl(request);
    return publicReceipt(receipt);
  } catch {
    return publicReceipt(receipt);
  } finally {
    answering = undefined;
  }
}

function validAnswer(request: AnswerRequest) {
  return (
    typeof request.requestId === "string" &&
    request.requestId.length <= 80 &&
    Number.isInteger(request.promptId) &&
    request.promptId >= 1 &&
    (request.option !== undefined || request.text !== undefined) &&
    (request.option === undefined ||
      (Number.isInteger(request.option) && request.option >= 0)) &&
    (request.text === undefined ||
      (typeof request.text === "string" &&
        request.text.length >= 1 &&
        request.text.length <= 32000 &&
        !/[\x00-\x08\x0b-\x1f\x7f]/.test(request.text)))
  );
}
function validTeamAnswer(request: TeamAnswerRequest) {
  return request.targetSessionId === session.id && teamAnswerWorkerRequestSchema.safeParse(request).success;
}

const server = createServer((socket) => {
  socket.setTimeout(5000, () => socket.destroy());
  let data = "";
  socket.on("error", () => {});
  socket.on("data", async (chunk) => {
    data += chunk;
    if (data.length > 96 * 1024) return socket.destroy();
    const end = data.indexOf("\n");
    if (end < 0) return;
    socket.pause();
    socket.setTimeout(0);
    try {
      const request = JSON.parse(data.slice(0, end)) as WorkerRequest;
      let result: unknown;
      if (request.op === "state") {
        currentControl();
        result = {
          ...state,
          attention,
          seq: journal.seq,
          screen: request.screen ? screen() : "",
        };
      } else if (request.op === "handoff-stop") {
        result = await serialize(async () => {
          if (!handoffReceipt || !session.handoff?.policy || !child || !/^[a-f0-9-]{36}$/.test(request.requestId)) throw new Refusal("unsupported");
          checkControl({});
          if (state.handoffQuiescence?.requestId === request.requestId) return state;
          if (state.status !== "running") throw new Error("The source exited without a verified handoff process receipt");
          handoffStopping = true;
          transcriptWatch.stopRequested();
          try {
            await stopHandoffProcesses(child.pid, processes => append("lifecycle", { handoffStopIntent: { requestId: request.requestId, processes } }));
            state = { ...state, handoffQuiescence: { requestId: request.requestId, verifiedAt: new Date().toISOString(), scope: "process-group-and-observed-descendants" } };
            append("lifecycle", { handoffQuiescence: state.handoffQuiescence }); persist();
            return state;
          } finally { handoffStopping = false; }
        });
      } else if (request.op === "snapshot") {
        result = await serialize(snapshot);
      } else if (request.op === "native-info") {
        result = native?.info() ?? null;
      } else if (request.op === "executor-connect") {
        if (!executor || !config.executorTokenHash || typeof request.token !== "string" ||
            !/^[a-f0-9]{64}$/.test(request.token) ||
            createHash("sha256").update(request.token).digest("hex") !== config.executorTokenHash ||
            !["starting", "running"].includes(state.status)) throw new Refusal("unsupported");
        result = executor.attach();
      } else if (request.op === "workspace-export") {
        const parsed = workerWorkspaceExportRequestSchema.safeParse(request);
        if (!parsed.success) throw new Error(!["sync/export", "sync/blob"].includes(String((request as { method?: unknown }).method)) ? "Unsupported workspace export method" : request.method === "sync/blob" && request.hash === undefined ? "A content hash is required" : "Invalid workspace export request");
        if (!hybrid) throw new Refusal("unsupported");
        result = await hybrid.control(parsed.data.method, parsed.data.method === "sync/blob" ? { hash: parsed.data.hash } : {});
      } else if (request.op === "native-connect") {
        result = await serialize(() => {
          if (!native || !request.actor || !request.leaseId || state.status !== "running") throw new Refusal("unsupported");
          return native.connect(request);
        });
      } else if (request.op === "control") {
        result = changeControl(request);
      } else if (request.op === "team-answer-invalidate") {
        if (!/^[a-f0-9-]{36}$/i.test(request.decisionId)) throw new Error("Invalid delegated decision identity");
        invalidatedTeamPermissionDecisions.add(request.decisionId);
        if (controller?.actorId === `team-permission:${request.decisionId}`) {
          controller = null;
          controlChangeGeneration++;
          state = { ...state, control: null };
          persist();
        }
        result = { invalidated: true };
      } else if (request.op === "session-permission-invalidate") {
        if (typeof request.decisionId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(request.decisionId)) throw new Error("Invalid permission decision identity");
        invalidatedSessionPermissionDecisions.add(request.decisionId);
        if (invalidatedSessionPermissionDecisions.size > 512) invalidatedSessionPermissionDecisions.delete(invalidatedSessionPermissionDecisions.values().next().value!);
        if (controller?.actorId === `session-permission:${request.decisionId}`) {
          controller = null;
          controlChangeGeneration++;
          state = { ...state, control: null };
          persist();
        }
        result = { invalidated: true };
      } else if (request.op === "resize") {
        if (
          !Number.isInteger(request.cols) ||
          !Number.isInteger(request.rows) ||
          request.cols < 20 ||
          request.cols > 240 ||
          request.rows < 5 ||
          request.rows > 100
        )
          throw new Error("Invalid terminal size");
        result = await serialize(() => {
          checkControl(request);
          child?.resize(request.cols, request.rows);
          terminal.resize(request.cols, request.rows);
          refreshControl(request);
          return { ok: true };
        });
      } else if (request.op === "answer") {
        if (!validAnswer(request)) throw new Error("Invalid answer request");
        result = await serialize(() => {
          if (!permissionChannel?.owns(request.promptId, request.requestId)) return answer(request);
          if (!request.missionManaged) checkControl(request);
          return permissionChannel.answer(request);
        });
      } else if (request.op === "team-answer") {
        if (!validTeamAnswer(request)) throw new Error("Invalid delegated answer request");
        result = await serialize(() => answer(request));
      } else if (request.op === "team-permission-expand") {
        if (!validTeamPermissionExpansion(request)) throw new Error("Invalid collapsed permission expansion request");
        result = await serialize(() => expandTeamPermission(request));
      } else if (request.op === "session-permission-answer") {
        if (!validSessionPermissionAnswer(request)) throw new Error("Invalid session permission answer request");
        result = await serialize(() => answerSessionPermission(request));
      } else {
        if (
          !["input", "raw", "key", "stop"].includes(request.op) ||
          typeof request.requestId !== "string" ||
          request.requestId.length > 80
        )
          throw new Error("Invalid input request");
        if (
          request.op === "raw" &&
          (typeof request.text !== "string" || request.text.length > 8192)
        )
          throw new Error("Invalid terminal input");
        if (
          request.op === "input" &&
          (typeof request.text !== "string" ||
            request.text.length > 32000 ||
            /[\x00-\x08\x0b-\x1f\x7f]/.test(request.text))
        )
          throw new Error("Input contains terminal control characters");
        if (
          request.op === "input" &&
          request.force !== undefined &&
          typeof request.force !== "boolean"
        )
          throw new Error("Invalid input request");
        if (
          request.op === "key" &&
          !["interrupt", "enter", "escape", "up", "down", "tab"].includes(
            request.key,
          )
        )
          throw new Error("Invalid key");
        result = await serialize(() => deliver(request));
      }
      socket.end(JSON.stringify({ result }) + "\n");
    } catch (error) {
      socket.end(
        JSON.stringify({
          error: (error as Error).message,
          ...(error instanceof Refusal ? { code: error.code } : {}),
        }) + "\n",
      );
    }
  });
});

const hookToken = randomBytes(32).toString("hex");
let resumeProvider: ((nativeSessionId: string) => void) | undefined;
let endSession: (() => void) | undefined;
const permissionChannel = config.permissionChannel && session.headless?.channel && provider === "claude"
  ? new HeadlessChannelWorker({
      sessionId: session.id,
      token: channelToken(key, session.id),
      socket: config.permissionChannel.socket,
      record: data => append("lifecycle", { permissionChannel: data }).seq,
      openPrompt: prompt => record({ kind: "prompt-open", prompt }, "protocol").seq,
      closePrompt: (promptId, label) => {
        if (attention.prompt?.id === promptId) record({ kind: "prompt-closed", promptId, reason: "answered-here", label }, "host");
      },
      publish: view => { state = { ...state, permissionChannel: view }; persist(); },
      resume: nativeSessionId => {
        if (!resumeProvider) throw new Error("The provider cannot be resumed");
        resumeProvider(nativeSessionId);
      },
      end: () => endSession?.(),
      refusal: code => new Refusal(code),
    })
  : undefined;
if (permissionChannel) setInterval(() => permissionChannel.tick(), 60_000).unref();
const wantsHooks =
  !session.runtime?.nativeUi &&
  (Boolean(session.handoff?.policy) || session.nativeArgs === undefined) &&
  (Boolean(session.handoff?.policy) || Boolean(session.team) || provider === "demo" || Boolean(permissionChannel) ||
    (provider === "claude" && config.attention.hooks.claude) ||
    (provider === "codex" && config.attention.hooks.codex));
const hookServer = wantsHooks
  ? await startHookServer({
      token: hookToken,
      onPayload: onHook,
      onError: () =>
        publish({ ...attention, hookErrors: attention.hookErrors + 1 }),
    }).catch(() => null)
  : null;
async function exitWorker(code: number) {
  native?.stop();
  const workspaceClosing = hybrid?.close();
  executor?.close();
  server.close();
  hookServer?.close();
  evidenceReader?.close();
  await workspaceClosing?.catch(() => {});
  try {
    unlinkSync(socketPath(runDir, session.id));
  } catch {
  }
  process.exit(code);
}

mkdirSync(runDir, { recursive: true, mode: 0o700 });
server.on("error", () => process.exit(1));
server.listen(socketPath(runDir, session.id), async () => {
  chmodSync(socketPath(runDir, session.id), 0o600);
  try {
    journal.append("lifecycle", {
      status: "starting",
      provider,
      contextVersion: session.contextVersion,
    });
    persist();
    const env: Record<string, string> = {};
    for (const name of [
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]) {
      if (process.env[name]) env[name] = process.env[name]!;
    }
    env.TERM = "xterm-256color";
    addProjectIdToLaunchEnv(env, session.projectId);
    addClaudeCodeModeToLaunchEnv(env, config.codeMode && !session.headless?.channel);
    if (config.codexTraceRoot) env.CODEX_ROLLOUT_TRACE_ROOT = config.codexTraceRoot;
    if (config.github) {
      env.INFINITE_GITHUB_GRANT = config.github.grant;
      env.INFINITE_GITHUB_PROXY = config.github.proxy;
    }
    if (session.team) {
      if (!hookServer) throw new Error("Team report channel could not start");
      const { verificationRefused: _refused, entryTools: _entryTools, hostProfiles: _hostProfiles, ...binding } = session.team;
      env.INFINITE_TEAM_ASSIGNMENT = JSON.stringify(binding);
      if (session.team.role === "mission-coordinator")
        env.INFINITE_MISSION_ASSIGNMENT = JSON.stringify({ missionId: session.team.runId, memberId: session.team.memberId, revision: session.team.revision });
      if (session.workspaceTrusted) {
        env.INFINITE_TRUSTED_WORKSPACE = session.cwd;
        if (provider === "claude" && env.HOME && !/(^|\/)sudo$/.test(profile.command))
          try { recordClaudeTrust(claudeConfigPath(env.HOME), session.cwd); }
          catch (error) { journal.append("lifecycle", { workspaceTrust: "unrecorded", reason: error instanceof Error ? error.message : String(error) }); }
      }
    }
    if (permissionChannel && !hookServer) throw new Error("The permission channel could not start");
    if (hookServer) {
      env.INFINITE_HOOK_URL = hookServer.url;
      env.INFINITE_HOOK_TOKEN = hookToken;
    }
    const egress = workerEgressEnvironment(session.projectId, session.id, process.env, Date.now(), session.purpose);
    if (egress.status === "invalid") throw new Error("The egress proxy address this worker inherited is unusable, so the session was not started");
    clearEgressEnvironment(env); Object.assign(env, egress.env);
    if (egress.status === "no-key") journal.append("lifecycle", { egress: "no-credential" });
    const relayPath = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts") ? "./hook-relay.ts" : "./hook-relay.js",
        import.meta.url,
      ),
    );
    let launch = buildLaunch(
      provider,
      profile,
      config.prompt,
      hookServer ? { url: hookServer.url, token: hookToken } : null,
      relayPath,
      config.attention.hooks,
      Boolean(session.team),
      session.teamModelProfile,
      session.handoff?.policy ? session.id : undefined,
      session.workspaceTrusted ? session.cwd : undefined,
      Boolean(session.team?.entryTools), Boolean(permissionChannel),
      egress.status !== "off",
      config.codeMode,
      session.runtime?.nativeUi ? 0 : session.nativeArgs?.length,
    );
    if (session.runtime?.nativeUi === "codex") {
      if (session.workspace) {
        hybrid = await createHybridWorkspace({
          workspace: session.workspace, directory: join(dir, "workspace"), sharedPoolDirectory: join(stateDir, "workspace-pool"),
          command: profile.command, commandArgs: profile.args, egress: egress.env,
          ...(profile.workspaceDir ? { workspaceDirectory: join(profile.workspaceDir, session.id), sharedWorkspace: profile.sharedWorkspace } : {}),
          record: data => { append("lifecycle", { execution: data }); },
          publish: execution => {
            state = { ...state, execution };
            executor?.pause(execution.location !== "laptop" || execution.state !== "online");
            persist();
          },
          select: async execution => {
            if (!native || !("selectExecution" in native)) throw new Error("Codex execution selection is unavailable");
            await native.selectExecution(execution, () => executor?.retire());
          },
        });
        executor = await createExecutorTunnel({
          cwd: session.workspace.cwd,
          onConnection: online => hybrid?.connection(online),
          onControl: (method, params) => hybrid!.control(method, params),
          onActivity: activity => hybrid?.activity(activity),
          record: data => { append("lifecycle", { executor: data }); },
        });
        persist();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([executor.ready, new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Laptop executor did not connect; no provider turn was started")), 30000);
          })]);
        } finally { clearTimeout(timeout); }
      }
      native = await startNativeCodex({
        profile, cwd: session.cwd, env,
        ...(executor && session.workspace ? { execution: { ...executor.environment, roots: session.workspace.roots } } : {}),
        onExecutionUnavailable: () => hybrid?.providerReady(false),
        noAltScreen: (session.nativeArgs ?? []).includes("--no-alt-screen"),
        checkControl: (authority) => {
          if (state.status !== "running" || !authority.actor || !authority.leaseId) throw new Refusal("control-lost");
          checkControl(authority);
        },
        onThread: (id) => {
          state = { ...state, nativeSession: { id, source: "protocol" }, capabilities: { terminalSnapshot: 1, inputControl: 1, nativeUi: "codex" } };
          persist();
        },
        onExit: () => { child?.kill("SIGTERM"); },
        onSignal: (signal) => {
          if (signal.kind === "provider-limit") { limitWatch = undefined; recordLimit(signal, "protocol"); } else record(signal, "protocol");
        },
        onMessage: (message) => { recordMessage(message); },
        record: (method) => { append("input-intent", { op: "native", method }); },
      });
      hybrid?.providerReady(native.supportsExecutionSelection);
      env.INFINITE_NATIVE_TOKEN = native.observerToken;
      launch = { command: profile.command, args: [...profile.args, "--remote", native.url,
        "--remote-auth-token-env", "INFINITE_NATIVE_TOKEN", ...validateNativeCodexArgs(session.nativeArgs ?? [], config.prompt, Boolean(session.workspace))] };
    }
    if (session.runtime?.nativeUi === "opencode") {
      const settings = validateNativeOpenCodeArgs(session.nativeArgs ?? [], config.prompt);
      native = await startNativeOpenCode({
        profile, cwd: session.cwd, env, title: session.title, settings,
        checkControl: authority => {
          if (state.status !== "running" || !authority.actor || !authority.leaseId) throw new Refusal("control-lost");
          checkControl(authority);
        },
        onThread: id => {
          state = { ...state, nativeSession: { id, source: "protocol" }, capabilities: { terminalSnapshot: 1, inputControl: 1, nativeUi: "opencode" } };
          persist();
        },
        onExit: () => { child?.kill("SIGTERM"); },
        onSignal: signal => { record(signal, "protocol"); return attention.prompt?.id; },
        onUsage: usage => { append("usage", { ...usage }); },
        record: method => { append("input-intent", { op: "native", method }); },
      });
      env.OPENCODE_SERVER_PASSWORD = native.observerToken;
      env.OPENCODE_SERVER_USERNAME = "infinite";
      launch = { command: profile.command, args: [...profile.args, ...(settings.pure ? ["--pure"] : []), "attach", native.url, "--session", native.info().sessionId, "--dir", session.cwd] };
    }
    for (const credential of sessionCredentials(env)) issuedCredentials.add(credential);
    child = spawn(launch.command, launch.args, {
      cwd: session.cwd,
      env,
      cols: 120,
      rows: 32,
      name: "xterm-256color",
    });
    state = { ...state, status: "running", pid: child.pid };
    publish(attention);
    journal.append("lifecycle", { status: "running", pid: child.pid });
    persist();
    const output = (data: string) => {
      pending += data;
      try {
        if (usageLines) for (const event of usageLines.push(data)) {
          const usage = session.teamModelProfile ? usageFromRunLine(event, session.teamModelProfile.model) : undefined;
          if (usage) append("usage", { ...usage });
          const tool = toolFromRunLine(event);
          if (tool) {
            record({ kind: "tool-start", tool: tool.tool, ...(tool.toolUseId ? { toolUseId: tool.toolUseId } : {}), input: {}, quiet: true }, "protocol");
            record({ kind: "tool-end", ...tool }, "protocol");
          }
        }
        snapshots.observe(data);
        terminal.write(data);
      } catch {
        recordingFailure();
      }
      lastOutputAt = Date.now();
      outputSinceCheck = true;
      if (!flushTimer)
        flushTimer = setTimeout(() => {
          try {
            flush();
          } catch {
            return;
          }
          checkScreen();
        }, 40);
    };
    const onData = (data: string) => {
      if (snapshotQueue) {
        snapshotQueue.push(() => output(data));
        snapshotBytes += Buffer.byteLength(data, "utf8");
        if (snapshotBytes > 2 * 1024 * 1024) abortSnapshot?.(new Error("Snapshot output queue is full"));
      } else output(data);
    };
    child.onData(onData);
    const finalDrain = async () => {
      try {
        if (!hookServer || !transcriptWatch.reading) return;
        const launch = drainLaunch(profile, relayPath);
        if (!launch) return;
        const drainEnv: Record<string, string> = {};
        for (const name of ["PATH", "HOME"]) {
          const value = process.env[name];
          if (value !== undefined) drainEnv[name] = value;
        }
        drainEnv.INFINITE_HOOK_URL = hookServer.url;
        drainEnv.INFINITE_HOOK_TOKEN = hookToken;
        drainOpen = true;
        try { await runFinalDrain(launch, drainEnv); } finally { drainOpen = false; }
      } catch {}
    };
    const exited = (exitCode: number) => {
      if (permissionChannel?.exited(exitCode)) return;
      native?.stop();
      void hybrid?.close().catch(() => {}); executor?.close();
      try {
        flush();
        controller = null;
        state = { ...state, status: "exited", exitCode, control: null };
        publish(applyLifecycle(attention, "exited", new Date().toISOString()));
        append("lifecycle", { status: "exited", exitCode });
        persist();
      } catch {
        recordingFailure();
      }
      void (async () => {
        await finalDrain();
        try {
          if (provider !== "opencode") append("usage-coverage", { ...transcriptWatch.finish(hooksReady, true) });
          persist();
        } catch {}
        const finish = () => { if (handoffStopping) setTimeout(finish, 100); else void exitWorker(0); };
        setTimeout(finish, 1500);
      })();
    };
    const onExit = ({ exitCode }: { exitCode: number }) => {
      if (snapshotQueue) snapshotQueue.push(() => exited(exitCode));
      else exited(exitCode);
    };
    child.onExit(onExit);
    resumeProvider = nativeSessionId => {
      const next = buildLaunch(
        provider, headlessResumeProfile(profile, nativeSessionId), "",
        hookServer ? { url: hookServer.url, token: hookToken } : null, relayPath, config.attention.hooks,
        Boolean(session.team), session.teamModelProfile, session.handoff?.policy ? session.id : undefined,
        session.workspaceTrusted ? session.cwd : undefined, Boolean(session.team?.entryTools), true, egress.status !== "off",
        config.codeMode,
      );
      const pty = spawn(next.command, next.args, { cwd: session.cwd, env, cols: terminal.cols, rows: terminal.rows, name: "xterm-256color" });
      child = pty;
      state = { ...state, status: "running", pid: pty.pid };
      append("lifecycle", { status: "running", pid: pty.pid, permissionChannel: { event: "resumed" } });
      persist();
      pty.onData(onData);
      pty.onExit(onExit);
    };
    endSession = () => exited(0);
  } catch (error) {
    state = { ...state, status: "exited", exitCode: 1 };
    publish(applyLifecycle(attention, "exited", new Date().toISOString()));
    journal.append("lifecycle", {
      status: "exited",
      error: (error as Error).message,
    });
    persist();
    void exitWorker(1);
  }
});
