/**
 * The headless permission channel inside a session's worker. The provider's PreToolUse and PermissionRequest hooks
 * reach it through the worker's hook server; it asks the host over the channel socket and answers the hook.
 *
 * A call that a class rule sends to the owner is deferred: the provider ends its run, the worker keeps the session
 * open with one owner prompt, and the owner's answer resumes the same conversation in place. The answer is returned
 * to that one call at most once. While a call waits, every other call of the session is denied as `pending`.
 * Nothing here allows a call on its own: an allow comes from the pipeline or from the owner's answer.
 */
import { createHash } from "node:crypto";
import type { Prompt } from "@infinite/attention";
import { channelCall, CLASS_CHECK_MS, DECIDE_MS, type ChannelCall, type ChannelReply, type ChannelRequest } from "./permission-headless.js";
import { requesterNotice, type RejectCode } from "./permission-policy.js";
import type { ChannelAnswer } from "./permission-hook.js";
import type { PermissionDelivery } from "./evidence/permission-journal.js";
import type { PermissionChannelView } from "./types.js";

/** Below the provider's own 30-day retention of a deferred call. */
export const DEFERRAL_RETENTION_MS = 29 * 24 * 60 * 60 * 1000;
export const OWNER_ALLOW = "Yes, allow once";
export const OWNER_DENY = "No";
export const OWNER_DENY_TEXT = "No, and tell Claude what to do differently";
/** The fixed text the agent receives when the owner refused its call. The owner's own words follow it, bounded. */
export const OWNER_DENIED = "Permission request rejected by the owner. This decision is final for this request.";
const DEFERRED_REASON = "This call waits for the owner's answer. The session resumes with that answer.";
/**
 * The host's fixed text for a call denied while another call of the session waits for the owner. It is not a reject
 * code: nothing was decided about this call and nothing is recorded in the permission journal for it.
 */
export const PENDING_NOTICE = "Permission request not decided yet (pending): another call of this session waits for the owner's answer. Retry this call after that decision.";

export type ChannelRefusalCode = "prompt-changed" | "invalid-option" | "text-not-accepted" | "prompt-open";

export interface ChannelWorkerHost {
  sessionId: string;
  /** The session's channel key, from the bootstrap. */
  token: string;
  socket: string;
  /** Journals `{ permissionChannel: data }` as a lifecycle event and returns its sequence number. */
  record(data: Record<string, unknown>): number;
  /** Opens the owner prompt and returns its id. */
  openPrompt(prompt: Prompt): number;
  closePrompt(promptId: number, label: string): void;
  publish(view: PermissionChannelView): void;
  /** Starts the provider again on the same conversation. Throws when it cannot start. */
  resume(nativeSessionId: string): void;
  /** Ends the session without starting the provider again. */
  end(): void;
  refusal(code: ChannelRefusalCode): Error;
  call?: typeof channelCall;
  now?: () => number;
}

interface Deferred {
  callId: string;
  tool: string;
  inputHash: string;
  interruptClass: string;
  rule: string;
  decisionId?: string;
  since: number;
  expiresAt: number;
  /** `deferring`: the provider is ending its run. `waiting`: the owner prompt is open. `resuming`: the owner answered. */
  phase: "deferring" | "waiting" | "resuming";
  promptId?: number;
  answer?: { decision: "allow" | "deny"; reason?: string };
}

interface OwnerAnswer { requestId: string; promptId: number; option?: number; text?: string }
type StoredAnswer = { digest: string; receipt: { requestId: string; state: "delivered"; seq: number; result: "closed" } };

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clean = (text: string, limit: number) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").trim().slice(0, limit);

/** The hook payload fields the channel reads. Anything else in the payload is ignored. */
function readCall(body: unknown): (ChannelCall & { nativeSessionId?: string }) | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  const input = b.tool_input;
  if (typeof b.tool_name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(b.tool_name) ||
      !input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const toolUseId = typeof b.tool_use_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(b.tool_use_id) ? b.tool_use_id : undefined;
  const agentId = typeof b.agent_id === "string" && b.agent_id.length >= 1 && b.agent_id.length <= 128 ? b.agent_id : undefined;
  // A subagent hook carries the primary's session id too, but only the primary's names the conversation to resume.
  const nativeSessionId = !b.agent_id && typeof b.session_id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(b.session_id) ? b.session_id : undefined;
  return {
    toolName: b.tool_name, toolInput: input as Record<string, unknown>,
    ...(toolUseId ? { toolUseId } : {}), ...(agentId ? { agentId } : {}), ...(nativeSessionId ? { nativeSessionId } : {}),
  };
}

export class HeadlessChannelWorker {
  private served = false;
  private nativeSessionId?: string;
  private deferred?: Deferred;
  /** Tool calls the class check saw, by agent, tool and input, for the PermissionRequest that has no call id. */
  private recent = new Map<string, string>();
  /** Call ids that already received the owner's answer. A repeat is denied. */
  private consumed = new Set<string>();
  private answers = new Map<string, StoredAnswer>();
  private notice?: PermissionChannelView["notice"];
  private requests = 0;
  constructor(private readonly host: ChannelWorkerHost) {}

  private now() { return (this.host.now ?? Date.now)(); }

  private ask(request: ChannelRequest extends infer R ? R extends ChannelRequest ? Omit<R, "v" | "sessionId" | "token"> : never : never, timeoutMs: number): Promise<ChannelReply> {
    return (this.host.call ?? channelCall)(this.host.socket, { v: 1, sessionId: this.host.sessionId, token: this.host.token, ...request } as ChannelRequest, timeoutMs);
  }

  /** Best effort: a delivery record that cannot be written leaves the decision recorded, and the answer stands. */
  private delivery(decisionId: string | undefined, kind: PermissionDelivery["kind"], detail: string) {
    if (!decisionId) return;
    void this.ask({ op: "delivery", decisionId, kind, detail }, CLASS_CHECK_MS).catch(() => {});
  }

  private deny(code: RejectCode): ChannelAnswer { return { decision: "deny", reason: requesterNotice(code) }; }

  /** Recorded only in the session's own journal. */
  private pending(tool: string): ChannelAnswer {
    this.host.record({ event: "pending", tool });
    return { decision: "deny", reason: PENDING_NOTICE };
  }

  private first(call: { nativeSessionId?: string }) {
    if (call.nativeSessionId) this.nativeSessionId = call.nativeSessionId;
    if (this.served) return;
    this.served = true;
    this.host.publish(this.view());
  }

  private tell(interruptClass: string | undefined, id: string | undefined) {
    this.notice = { id: id ?? hash({ at: this.now(), n: ++this.requests }).slice(0, 32), ...(interruptClass ? { interruptClass } : {}), at: new Date(this.now()).toISOString() };
    this.host.publish(this.view());
  }

  /** The PreToolUse hook. */
  async check(body: unknown): Promise<ChannelAnswer> {
    const call = readCall(body);
    if (!call) return this.deny("unavailable");
    this.first(call);
    const inputHash = hash(call.toolInput);
    const deferred = this.deferred;
    if (call.toolUseId && this.consumed.has(call.toolUseId)) return this.deny("needs-owner");
    if (deferred && call.toolUseId === deferred.callId) {
      if (deferred.phase !== "resuming" || !deferred.answer) return this.pending(call.toolName);
      // The owner's answer is returned once, to the call it was given for.
      this.consumed.add(deferred.callId);
      this.deferred = undefined;
      const changed = deferred.tool !== call.toolName || deferred.inputHash !== inputHash;
      const answer: ChannelAnswer = changed ? this.deny("needs-owner")
        : deferred.answer.decision === "allow" ? { decision: "allow" } : { decision: "deny", reason: deferred.answer.reason ?? OWNER_DENIED };
      this.host.record({ event: "delivered", callId: deferred.callId, decision: changed ? "changed" : deferred.answer.decision });
      this.delivery(deferred.decisionId, changed ? "stale" : "receipt", changed
        ? "Headless: the resumed call differs from the call the owner answered; it was denied."
        : `Headless: the owner's ${deferred.answer.decision === "allow" ? "allow" : "refusal"} was returned to the resumed call.`);
      this.host.publish(this.view());
      return answer;
    }
    if (deferred) return this.pending(call.toolName);
    if (call.toolUseId) {
      this.recent.set(`${call.agentId ?? ""}\n${call.toolName}\n${inputHash}`, call.toolUseId);
      if (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value!);
    }
    let reply: ChannelReply;
    try { reply = await this.ask({ op: "class", call }, CLASS_CHECK_MS); }
    catch { return this.deny("unavailable"); }
    if (reply.result === "not-served" || reply.result === "none") return { decision: "none" };
    if (reply.result !== "owner") return this.deny("unavailable");
    // A call that waits must be one the provider can return to: the primary agent's, with its call id. A subagent's
    // deferred call does not end the run, so it is denied and the owner is told.
    if (call.agentId || !call.toolUseId || !this.nativeSessionId || this.deferred) {
      this.host.record({ event: "owner-denied", tool: call.toolName, interruptClass: reply.interruptClass, reason: call.agentId ? "subagent" : "no-call-id" });
      this.delivery(reply.decisionId, "refusal", "Headless: this call cannot wait for the owner; it was denied with needs-owner.");
      this.tell(reply.interruptClass, reply.decisionId);
      return this.deny("needs-owner");
    }
    const since = this.now();
    this.deferred = {
      callId: call.toolUseId, tool: call.toolName, inputHash, interruptClass: reply.interruptClass, rule: reply.rule,
      ...(reply.decisionId ? { decisionId: reply.decisionId } : {}), since, expiresAt: since + DEFERRAL_RETENTION_MS, phase: "deferring",
    };
    this.host.record({
      event: "deferred", callId: call.toolUseId, tool: call.toolName, interruptClass: reply.interruptClass, rule: reply.rule,
      ...(reply.decisionId ? { decisionId: reply.decisionId } : {}), expiresAt: new Date(since + DEFERRAL_RETENTION_MS).toISOString(),
    });
    this.delivery(reply.decisionId, "intent", "Headless: the call was deferred; it waits for the owner's answer.");
    return { decision: "defer", reason: DEFERRED_REASON };
  }

  /** The PermissionRequest hook: a call that the provider's own rules left open. */
  async request(body: unknown): Promise<ChannelAnswer> {
    const call = readCall(body);
    if (!call) return this.deny("unavailable");
    this.first(call);
    if (this.deferred) return this.pending(call.toolName);
    const inputHash = hash(call.toolInput);
    const key = `${call.agentId ?? ""}\n${call.toolName}\n${inputHash}`;
    const callId = call.toolUseId ?? this.recent.get(key);
    if (callId) this.recent.delete(key);
    // Stable for this raised request; an uncorrelated request gets an id of its own.
    const requestId = `headless:${this.host.sessionId}:${callId ?? `r${++this.requests}-${inputHash.slice(0, 24)}`}`;
    const forwarded: ChannelCall = { toolName: call.toolName, toolInput: call.toolInput, ...(callId ? { toolUseId: callId } : {}), ...(call.agentId ? { agentId: call.agentId } : {}) };
    let reply: ChannelReply;
    try { reply = await this.ask({ op: "decide", call: forwarded, requestId }, DECIDE_MS); }
    catch { return this.deny("unavailable"); }
    if (reply.result === "not-served") return { decision: "none" };
    if (reply.result === "allow") return { decision: "allow" };
    if (reply.result !== "deny") return this.deny("unavailable");
    if (reply.interruptClass) this.tell(reply.interruptClass === "undeliverable" ? undefined : reply.interruptClass, reply.decisionId);
    // The notice is rebuilt here from the code as well, so only host text reaches the provider.
    return this.deny(reply.code);
  }

  /** The provider exited. True when the session stays open because a deferred call waits for the owner. */
  exited(exitCode: number): boolean {
    const deferred = this.deferred;
    if (!deferred) return false;
    if (deferred.phase === "deferring" && exitCode === 0 && this.nativeSessionId) {
      deferred.phase = "waiting";
      deferred.promptId = this.host.openPrompt({
        id: 0, kind: "permission", source: "protocol", acceptsText: true,
        title: `Owner answer needed (${deferred.interruptClass})`.slice(0, 200),
        detail: `${deferred.tool}: the permission agent's class rule ${deferred.rule} reserves this call for you. The session resumes with your answer.`.slice(0, 500),
        options: [
          { index: 0, label: OWNER_ALLOW, role: "accept" },
          { index: 1, label: OWNER_DENY, role: "reject" },
          { index: 2, label: OWNER_DENY_TEXT, role: "reject-with-feedback" },
        ],
      } as Prompt);
      this.host.record({ event: "waiting", callId: deferred.callId, promptId: deferred.promptId });
      this.host.publish(this.view());
      return true;
    }
    // The provider ended another way, or the resumed provider ended before it asked for the call again.
    this.retireCall(deferred.phase === "resuming" ? "resume-ended" : "provider-exited");
    return false;
  }

  /** The call waits and the provider is not running: input cannot reach the session now. */
  waiting(): boolean { return this.deferred?.phase === "waiting"; }

  /** The answer belongs to the channel: its prompt waits now, or the request already answered it. */
  owns(promptId: number, requestId: string): boolean {
    return this.answers.has(requestId) || (this.deferred?.promptId === promptId && this.deferred.phase === "waiting");
  }

  /** The owner's answer through the session's answer route. At most one answer is accepted; a retry gets its receipt. */
  answer(request: OwnerAnswer): StoredAnswer["receipt"] {
    const digest = hash({ promptId: request.promptId, option: request.option, text: request.text });
    const previous = this.answers.get(request.requestId);
    if (previous) {
      if (previous.digest !== digest) throw new Error("Request ID already belongs to different input");
      return previous.receipt;
    }
    const deferred = this.deferred;
    if (!deferred || deferred.phase !== "waiting" || deferred.promptId !== request.promptId) throw this.host.refusal("prompt-changed");
    const option = request.option ?? (request.text !== undefined ? 2 : undefined);
    if (option === undefined || ![0, 1, 2].includes(option)) throw this.host.refusal("invalid-option");
    if (request.text !== undefined && option !== 2) throw this.host.refusal("text-not-accepted");
    const direction = request.text !== undefined ? clean(request.text, 1000) : "";
    const decision = option === 0 ? "allow" as const : "deny" as const;
    deferred.answer = { decision, ...(decision === "deny" ? { reason: direction ? `${OWNER_DENIED} Owner direction: ${direction}` : OWNER_DENIED } : {}) };
    deferred.phase = "resuming";
    const seq = this.host.record({ event: "answer", callId: deferred.callId, requestId: request.requestId, decision, text: direction.length > 0 });
    const receipt = { requestId: request.requestId, state: "delivered" as const, seq, result: "closed" as const };
    this.answers.set(request.requestId, { digest, receipt });
    this.host.closePrompt(deferred.promptId!, [OWNER_ALLOW, OWNER_DENY, OWNER_DENY_TEXT][option]);
    this.delivery(deferred.decisionId, "intent", `Headless: the owner ${decision === "allow" ? "allowed the call once" : "refused the call"}; the session resumes.`);
    this.host.publish(this.view());
    try { this.host.resume(this.nativeSessionId!); }
    catch {
      this.retireCall("resume-failed");
      this.host.end();
    }
    return receipt;
  }

  /** Stop, or the retention limit: the waiting call is retired unanswered and the session ends. */
  retire(reason: "stopped" | "expired") {
    if (!this.deferred) return;
    const waiting = this.deferred.phase === "waiting";
    this.retireCall(reason);
    if (waiting) this.host.end();
  }

  private retireCall(reason: string) {
    const deferred = this.deferred;
    if (!deferred) return;
    this.deferred = undefined;
    if (deferred.promptId !== undefined && deferred.phase === "waiting") this.host.closePrompt(deferred.promptId, OWNER_DENY);
    this.host.record({ event: "retired", callId: deferred.callId, reason });
    this.delivery(deferred.decisionId, "refusal", `Headless: the deferred call was retired unanswered (${reason}).`);
    this.host.publish(this.view());
  }

  /** Runs once a minute. */
  tick() {
    if (this.deferred?.phase === "waiting" && this.now() >= this.deferred.expiresAt) this.retire("expired");
  }

  view(): PermissionChannelView {
    const deferred = this.deferred;
    return {
      served: this.served,
      ...(deferred && deferred.phase === "waiting" ? { waiting: {
        interruptClass: deferred.interruptClass, tool: deferred.tool,
        since: new Date(deferred.since).toISOString(), expiresAt: new Date(deferred.expiresAt).toISOString(),
      } } : {}),
      ...(this.notice ? { notice: this.notice } : {}),
    };
  }
}
