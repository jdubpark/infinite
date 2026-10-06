import { createServer } from "node:net";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
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
  screenDecision,
  type AnswerResult,
  type Attention,
  type Prompt,
  type Signal,
  type SignalData,
  type SignalEvent,
} from "@infinite/attention";
import { Journal, writeSealed } from "./vault.js";
import { socketPath } from "./ipc.js";
import { startHookServer, type HookRoute } from "./hooks.js";
import { buildLaunch } from "./launch.js";
import { TerminalSnapshots } from "./terminal-snapshot.js";
import type {
  Bootstrap,
  ControlActor,
  ControlLease,
  Event,
  InputControl,
  Receipt,
  TerminalSnapshot,
  WorkerRequest,
  WorkerState,
} from "./types.js";

// Bootstrap arrives through a private pipe, never argv, environment, or logs.
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
type DeliveryRequest = Extract<WorkerRequest, { op: "input" | "raw" | "key" | "stop" }>;
type StoredReceipt = Receipt & { digest: string; result?: AnswerResult };
const receipts = new Map<string, StoredReceipt>();
/** The receipt a client sees: the request digest stays inside the worker. */
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
};
let child: ReturnType<typeof spawn> | undefined;
// The host terminal must answer device/cursor queries even with no client attached.
terminal.onData((data) => {
  if (state.status === "running") child?.write(data);
});
// Codex TUI notifications arrive as OSC 9 inside the PTY stream.
terminal.parser.registerOscHandler(9, (data) => {
  if (provider !== "codex" || state.status !== "running") return false;
  try {
    for (const signal of mapCodexOsc(data)) {
      // An open prompt already covers "approval requested"; the screen supplies its options.
      if (signal.kind === "prompt-open" && attention.prompt) continue;
      record(signal, "osc");
    }
  } catch {
    /* journal failures already went through recordingFailure() */
  }
  return false; // let xterm keep its default handling
});
let pending = "";
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let snapshotQueue: (() => void)[] | undefined;
let snapshotBytes = 0;
let abortSnapshot: ((error: Error) => void) | undefined;
const persist = () =>
  writeSealed(join(dir, "status.sealed"), key, `${session.id}:status`, {
    ...state,
    screen: "",
    seq: journal.seq,
  });
/** Every journal write goes through here so a failed write always suspends the session. */
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

/** A short per-worker fence makes the ANSI frame and its journal cursor one atomic prefix. */
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
      // Empty writes are ordered behind every pending xterm write and invoke their callback.
      terminal.write("", resolve);
    });
    // Parser callbacks can change the worker state while the write barrier is pending.
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
/** Replace the attention snapshot, refresh its one-line summary and expose it in `state`. */
function publish(next: Attention) {
  attention = { ...next, now: describeNow(next, provider) };
  state = { ...state, attention };
}
function recordingFailure() {
  state = { ...state, status: "recording-error" };
  publish(
    applyLifecycle(attention, "recording-error", new Date().toISOString()),
  );
  // Stop work when recording fails instead of silently losing the audit trail.
  try {
    child?.kill("SIGSTOP");
  } catch {
    /* best effort */
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

// ---- Attention: signals from hooks, OSC and the screen -------------------------------------

function record(
  signal: Signal,
  source: SignalData["source"],
  agent?: { id: string; type: string },
): SignalEvent {
  // A signal that would drop the open prompt closes it in the journal first, so every
  // prompt-open has exactly one prompt-closed and the timeline never waits on a lost dialog.
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
  return event;
}

/** A hook announced a prompt while another is open. */
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
  // An answer is pressing keys on this dialog: nothing may rebind or replace it meanwhile.
  if (answering === open.id) return mismatch();
  const onScreen = open.hash !== undefined ? screenPrompt() : null;
  if (onScreen && hashOf(onScreen.fingerprint) === open.hash) {
    // Another dialog's hook (a parallel tool or a subagent) must not lend the answer its tool
    // and flags: the answer stays bound to the dialog on screen, and the mismatch is recorded.
    if (correlates(hook, onScreen))
      publish({
        ...attention,
        prompt: mergeHookIntoPrompt(open, hook, onScreen),
      });
    else mismatch();
    return;
  }
  // The open prompt is hook-only, or its block has left the screen: the newer prompt replaces it.
  record(
    { kind: "prompt-closed", promptId: open.id, reason: "superseded" },
    "hook",
  );
  record({ kind: "prompt-open", prompt: hook }, "hook", agent);
}

/** The open prompt's own block is on screen: the screen hash still matches. */
function blockShown(open: Prompt) {
  if (open.hash === undefined) return false;
  const current = screenPrompt();
  return current !== null && hashOf(current.fingerprint) === open.hash;
}

let hooksReady = false;
function onHook(route: HookRoute, body: unknown) {
  if (state.status !== "running") return;
  const signals =
    route === "claude"
      ? mapClaudeHook(body)
      : route === "codex"
        ? mapCodexHook(body)
        : mapCodexNotify(body);
  const agent = route === "claude" ? claudeAgent(body) : undefined;
  const b = body as Record<string, unknown>;
  const event =
    typeof b.hook_event_name === "string"
      ? b.hook_event_name
      : typeof b.type === "string"
        ? b.type
        : route;
  // Only the authenticated provider hook supplies its native identity. Subagent hooks do not
  // replace the primary conversation, and terminal text / transcript filenames are never guessed.
  const nativeId = !b.agent_id && (
    ((provider === "claude" && route === "claude") || (provider === "codex" && route === "codex")) &&
      typeof b.hook_event_name === "string"
      ? b.session_id
      : provider === "codex" && route === "codex-notify" && b.type === "agent-turn-complete"
        ? b["thread-id"]
        : undefined
  );
  if (typeof nativeId === "string" && nativeId.length >= 1 && nativeId.length <= 200 &&
      !/[\x00-\x20\x7f]/.test(nativeId) && nativeId !== state.nativeSession?.id) {
    state = { ...state, nativeSession: { id: nativeId, source: "hook" } };
    persist();
  }
  if (!hooksReady) {
    hooksReady = true;
    record({ kind: "hooks-ready", event: event.slice(0, 60) }, "hook");
  }
  for (const signal of signals) {
    if (signal.kind === "prompt-closed") {
      // A hook's close (PermissionDenied) names no prompt; it closes the open one, unless an
      // answer is pressing keys on it or its block is still on screen (the screen loop owns that).
      const open = attention.prompt;
      if (!open || answering === open.id || blockShown(open)) continue;
      record({ ...signal, promptId: open.id }, "hook", agent);
      continue;
    }
    if (signal.kind === "prompt-open" && attention.prompt) {
      // Claude's Notification opens a prompt only when none is open; it repeats the dialog's hook.
      if (route === "claude" && event === "Notification") continue;
      hookPromptWhileOpen(attention.prompt, signal.prompt, agent);
      continue;
    }
    record(signal, "hook", agent);
  }
}

let lastOutputAt = Date.now();
let outputSinceCheck = false;
let missCount = 0;
/** Prompt id with an answer in flight; the answer path, not the screen loop, closes it. */
let answering: number | undefined;

/** Runs after every output flush and once a second. */
function checkScreen() {
  if (state.status !== "running") return;
  try {
    const lines = screen().split("\n");
    const detected = detectPrompt(lines, provider);
    const nowMs = Date.now();
    const at = new Date(nowMs).toISOString();
    const idle =
      !outputSinceCheck &&
      nowMs - lastOutputAt >= config.attention.idleAfterMs &&
      isIdleScreen(lines, provider);
    // Output printed before the current state began (a redraw just ahead of the Stop hook)
    // is not new work.
    const freshOutput =
      outputSinceCheck && lastOutputAt > Date.parse(attention.since);
    outputSinceCheck = false;
    let decision = screenDecision(attention, detected, idle, freshOutput, at);
    const open = attention.prompt;
    // A different block in place of the open one supersedes it without a blank screen between.
    const replaced =
      detected !== null &&
      open?.hash !== undefined &&
      open.options.length > 0 &&
      hashOf(detected.fingerprint) !== open.hash;
    if (open && (decision.close || replaced) && answering !== open.id) {
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
    // A hook prompt waiting for its block is merged only with a block that belongs to it;
    // any other block supersedes it and opens as a screen prompt.
    if (decision.merge && open && !correlates(open, decision.merge)) {
      record(
        { kind: "prompt-closed", promptId: open.id, reason: "superseded" },
        "screen",
      );
      decision = screenDecision(attention, detected, idle, freshOutput, at);
    }
    if (decision.open) {
      const { fingerprint, ...rest } = decision.open;
      const prompt: Prompt = {
        ...rest,
        id: 0,
        hash: hashOf(fingerprint),
        destructive: blockDestructive(rest),
      };
      record({ kind: "prompt-open", prompt }, "screen");
    }
    if (decision.merge && attention.prompt) {
      const merged = mergeScreenIntoPrompt(
        attention.prompt,
        decision.merge,
        hashOf(decision.merge.fingerprint),
      );
      publish({ ...attention, prompt: merged });
      // The journaled prompt-open carries the hook's title; the timeline takes the dialog's.
      record(
        {
          kind: "notice",
          type: "prompt-merged",
          promptId: merged.id,
          title: merged.title,
          ...(merged.detail !== undefined ? { detail: merged.detail } : {}),
        },
        "screen",
      );
    }
    if (decision.idle) {
      const same = attention.state === decision.idle;
      publish({
        ...attention,
        state: decision.idle,
        since: same ? attention.since : at,
        source: same ? attention.source : "screen",
      });
    }
    if (decision.working)
      publish({ ...attention, state: "working", since: at, source: "screen" });
    // Keep the one-line summary current even when nothing above changed the state.
    if (describeNow(attention, provider) !== attention.now) publish(attention);
  } catch {
    /* journal failures already went through recordingFailure() */
  }
}
setInterval(checkScreen, 1000).unref();

// ---- Input: text, keys, stop and prompt answers, one at a time ------------------------------

let serial: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => T | Promise<T>): Promise<T> {
  const run = serial.then(task);
  serial = run.catch(() => {});
  return run;
}

const CONTROL_TTL_MS = 30_000;
let controller: { actorId: string; lease: ControlLease } | null = null;
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
function changeControl(request: Extract<WorkerRequest, { op: "control" }>): ControlLease | null {
  if (!validActor(request.actor) || !["claim", "renew", "release"].includes(request.action) ||
    (request.takeover !== undefined && typeof request.takeover !== "boolean"))
    throw new Error("Invalid session control");
  validateControl(request);
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
    } else controller!.lease.expiresAt = Date.now() + CONTROL_TTL_MS;
  } else {
    if (!owns) throw new Refusal("control-lost");
    if (request.action === "release") controller = null;
    else controller!.lease.expiresAt = Date.now() + CONTROL_TTL_MS;
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
  // A lease that expired while its input was being written ends; the input does not revive it.
  if (currentControl() && controller && request.leaseId === controller.lease.id && request.actor?.id === controller.actorId)
    controller.lease.expiresAt = Date.now() + CONTROL_TTL_MS;
}
/** A retry identifies the intended input, not the client which currently holds control. */
function requestDigest(request: (DeliveryRequest | AnswerRequest)) {
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
  if (state.status !== "running" || !child)
    throw new Error("Session is not running");
  // Text and Enter typed over an open dialog would pick its highlighted option. Only a
  // terminal surface, where the person sees the dialog, may send it anyway (`force`).
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
  if (request.op === "input") {
    // Bracketed paste keeps embedded newlines inside one prompt.
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
  } else child.kill("SIGTERM");
  const result = append("input-result", {
    requestId: request.requestId,
    state: "delivered",
  });
  receipt.state = "delivered";
  receipt.seq = result.seq;
  refreshControl(request);
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
/** A refusal the client can act on; its `code` travels to the API as a 409. */
class Refusal extends Error {
  constructor(readonly code: RefusalCode) {
    super(code);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Send arrows the way a real terminal would in the TUI's current cursor-key mode.
const arrow = (key: "up" | "down") =>
  (terminal.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[") +
  (key === "up" ? "A" : "B");

async function answer(
  request: AnswerRequest,
): Promise<Receipt & { result?: AnswerResult }> {
  const digest = requestDigest(request);
  const previous = receipts.get(request.requestId);
  if (previous) {
    if (previous.digest !== digest || previous.result === undefined)
      throw new Error("Request ID already belongs to different input");
    return publicReceipt(previous);
  }
  checkControl(request);
  const pty = child;
  if (state.status !== "running" || !pty)
    throw new Error("Session is not running");
  const prompt = attention.prompt;
  if (
    attention.state !== "needs-you" ||
    !prompt ||
    prompt.id !== request.promptId ||
    !prompt.hash // hook-only prompts have no verified screen block to answer
  )
    throw new Refusal("prompt-changed");
  const current = screenPrompt();
  if (!current || hashOf(current.fingerprint) !== prompt.hash)
    throw new Refusal("prompt-changed");
  if (prompt.multiSelect || current.multiSelect)
    throw new Refusal("unsupported");
  // Same hash, so the screen's options are the prompt's options.
  if (request.option !== undefined && !current.options[request.option])
    throw new Refusal("invalid-option");
  // Delivery follows the dialog on screen, not the hook's kind for it.
  const yesNo = current.kind === "yes-no";
  const feedback = current.options.find(
    (o) => o.role === "reject-with-feedback",
  );
  if (
    request.text !== undefined &&
    // Free text only follows the "No, and tell … what to do differently" option.
    (!prompt.acceptsText ||
      yesNo ||
      !feedback ||
      (request.option !== undefined && request.option !== feedback.index) ||
      (request.text.includes("\n") && !terminal.modes.bracketedPasteMode))
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
    ...(request.text !== undefined ? { text: request.text } : {}),
  });
  const receipt: StoredReceipt & { result: AnswerResult } = {
    requestId: request.requestId,
    state: "uncertain",
    seq: intent.seq,
    digest,
    result: "refused",
  };
  receipts.set(request.requestId, receipt);
  const unchanged = () => {
    const now = screenPrompt();
    return now && hashOf(now.fingerprint) === prompt.hash ? now : null;
  };
  answering = prompt.id;
  try {
    let result: AnswerResult = "still-open";
    if (yesNo) {
      pty.write(keys[0]);
      await sleep(40);
      pty.write("\r");
    } else {
      for (const key of keys.slice(0, -1)) {
        pty.write(arrow(key as "up" | "down"));
        await sleep(40);
      }
      // Enter goes only once the marker sits on the chosen option of the same dialog.
      let onTarget = false;
      for (const until = Date.now() + 500; ; ) {
        await sleep(40);
        const now = unchanged();
        if (!now) break;
        if (now.highlighted === undefined || now.highlighted === chosen.index) {
          onTarget = true;
          break;
        }
        if (Date.now() >= until) break;
      }
      if (onTarget) pty.write("\r");
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
      // A turn-end hook that raced the post-check may have closed it already.
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
      if (request.text !== undefined) {
        await sleep(150);
        pty.write(
          terminal.modes.bracketedPasteMode
            ? `\x1b[200~${request.text}\x1b[201~`
            : request.text,
        );
        pty.write("\r");
      }
    }
    record(
      {
        kind: "answer",
        promptId: prompt.id,
        requestId: request.requestId,
        option: { index: chosen.index, label: chosen.label },
        text: request.text !== undefined,
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
    // The request is complete: the idle timeout guards slow senders, not a slow answer.
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
      } else if (request.op === "snapshot") {
        result = await serialize(snapshot);
      } else if (request.op === "control") {
        result = await serialize(() => changeControl(request));
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
        result = await serialize(() => answer(request));
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
        // Waits for an in-flight answer so keystrokes never interleave with its arrows.
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

// ---- Launch ---------------------------------------------------------------------------------

const hookToken = randomBytes(32).toString("hex");
// A native CLI launch runs its exact argv: no hook listener, settings or relay environment.
const wantsHooks =
  session.nativeArgs === undefined &&
  (provider === "demo" ||
    (provider === "claude" && config.attention.hooks.claude) ||
    (provider === "codex" && config.attention.hooks.codex));
// Hooks only add precision; the screen heuristics still work if the listener cannot start.
const hookServer = wantsHooks
  ? await startHookServer({
      token: hookToken,
      onPayload: onHook,
      onError: () =>
        publish({ ...attention, hookErrors: attention.hookErrors + 1 }),
    }).catch(() => null)
  : null;
function exitWorker(code: number) {
  server.close();
  hookServer?.close();
  try {
    unlinkSync(socketPath(runDir, session.id));
  } catch {
    /* already gone */
  }
  process.exit(code);
}

mkdirSync(runDir, { recursive: true, mode: 0o700 });
server.on("error", () => process.exit(1));
server.listen(socketPath(runDir, session.id), () => {
  chmodSync(socketPath(runDir, session.id), 0o600);
  try {
    journal.append("lifecycle", {
      status: "starting",
      provider,
      contextVersion: session.contextVersion,
    });
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
    if (hookServer) {
      env.INFINITE_HOOK_URL = hookServer.url;
      env.INFINITE_HOOK_TOKEN = hookToken;
    }
    const relayPath = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts") ? "./hook-relay.ts" : "./hook-relay.js",
        import.meta.url,
      ),
    );
    const launch = buildLaunch(
      provider,
      profile,
      config.prompt,
      hookServer ? { url: hookServer.url, token: hookToken } : null,
      relayPath,
      config.attention.hooks,
    );
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
            return; // flush() already suspended the session
          }
          checkScreen();
        }, 40);
    };
    child.onData((data) => {
      if (snapshotQueue) {
        snapshotQueue.push(() => output(data));
        snapshotBytes += Buffer.byteLength(data, "utf8");
        if (snapshotBytes > 2 * 1024 * 1024) abortSnapshot?.(new Error("Snapshot output queue is full"));
      } else output(data);
    });
    const exited = (exitCode: number) => {
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
      setTimeout(() => exitWorker(0), 1500);
    };
    child.onExit(({ exitCode }) => {
      if (snapshotQueue) snapshotQueue.push(() => exited(exitCode));
      else exited(exitCode);
    });
  } catch (error) {
    state = { ...state, status: "exited", exitCode: 1 };
    publish(applyLifecycle(attention, "exited", new Date().toISOString()));
    journal.append("lifecycle", {
      status: "exited",
      error: (error as Error).message,
    });
    persist();
    exitWorker(1);
  }
});
