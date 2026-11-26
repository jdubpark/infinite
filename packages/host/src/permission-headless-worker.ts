import { createHash } from "node:crypto";
import type { Prompt, Signal } from "@infinite/attention";
import { channelCall, CLASS_CHECK_MS, DECIDE_MS, type ChannelCall, type ChannelReply, type ChannelRequest, type IssuedDecision } from "./permission-headless.js";
import { requesterNotice, type RejectCode } from "./permission-policy.js";
import type { ChannelAnswer } from "./permission-hook.js";
import type { PermissionDelivery } from "./evidence/permission-journal.js";
import type { PermissionChannelView } from "./types.js";

export const DEFERRAL_RETENTION_MS = 29 * 24 * 60 * 60 * 1000;
export const OWNER_ALLOW = "Yes, allow once";
export const OWNER_DENY = "No";
export const OWNER_DENY_TEXT = "No, and tell Claude what to do differently";
export const OWNER_DENIED = "Permission request rejected by the owner. This decision is final for this request.";
const DEFERRED_REASON = "This call waits for the owner's answer. The session resumes with that answer.";
export const PENDING_NOTICE = "Permission request not decided yet (pending): another call of this session waits for the owner's answer. Retry this call after that decision.";

export type ChannelRefusalCode = "prompt-changed" | "invalid-option" | "text-not-accepted" | "prompt-open";

export interface ChannelWorkerHost {
  sessionId: string;
  token: string;
  socket: string;
  record(data: Record<string, unknown>): number;
  openPrompt(prompt: Prompt): number;
  closePrompt(promptId: number, label: string): void;
  publish(view: PermissionChannelView): void;
  resume(nativeSessionId: string): void;
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
  issued?: IssuedDecision;
  sessionRoot?: string;
  since: number;
  expiresAt: number;
  phase: "deferring" | "waiting" | "resuming";
  promptId?: number;
  answer?: { decision: "allow" | "deny"; reason?: string };
}

interface OwnerAnswer { requestId: string; promptId: number; option?: number; text?: string }
type StoredAnswer = { digest: string; receipt: { requestId: string; state: "delivered"; seq: number; result: "closed" } };

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clean = (text: string, limit: number) => text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").trim().slice(0, limit);
const callKey = (call: ChannelCall, inputHash: string) => `${call.agentId ?? ""}\n${call.toolName}\n${inputHash}`;
export const OPEN_CALL_KEYS = 4096;

function readCall(body: unknown): (ChannelCall & { nativeSessionId?: string }) | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  const input = b.tool_input;
  if (typeof b.tool_name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(b.tool_name) ||
      !input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const toolUseId = typeof b.tool_use_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(b.tool_use_id) ? b.tool_use_id : undefined;
  const agentId = typeof b.agent_id === "string" && b.agent_id.length >= 1 && b.agent_id.length <= 128 ? b.agent_id : undefined;
  const nativeSessionId = !b.agent_id && typeof b.session_id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(b.session_id) ? b.session_id : undefined;
  return {
    toolName: b.tool_name, toolInput: input as Record<string, unknown>,
    ...(toolUseId ? { toolUseId } : {}), ...(agentId ? { agentId } : {}), ...(nativeSessionId ? { nativeSessionId } : {}),
  };
}

export function claudeTurnSignals(signals: Signal[], continued: () => boolean): Signal[] {
  return signals.map(signal => signal.kind === "turn-start" && continued() ? { ...signal, automatic: true as const } : signal);
}

export class HeadlessChannelWorker {
  private served = false;
  private nativeSessionId?: string;
  private deferred?: Deferred;
  private recent = new Map<string, string | number>();
  private lost = false;
  private runs = 1;
  private running = true;
  private continueOwed = false;
  private consumed = new Set<string>();
  private answers = new Map<string, StoredAnswer>();
  private notice?: PermissionChannelView["notice"];
  private requests = 0;
  constructor(private readonly host: ChannelWorkerHost) {}

  private now() { return (this.host.now ?? Date.now)(); }

  get run(): number { return this.runs; }

  private stale(run: string | undefined) { return !this.running || run !== String(this.runs); }

  private ask(request: ChannelRequest extends infer R ? R extends ChannelRequest ? Omit<R, "v" | "sessionId" | "token"> : never : never, timeoutMs: number): Promise<ChannelReply> {
    return (this.host.call ?? channelCall)(this.host.socket, { v: 1, sessionId: this.host.sessionId, token: this.host.token, ...request } as ChannelRequest, timeoutMs);
  }

  private delivery(issued: Partial<IssuedDecision> | undefined, kind: PermissionDelivery["kind"], detail: string) {
    if (!issued?.decisionId || !issued.deliveryKey) return;
    void this.ask({ op: "delivery", decisionId: issued.decisionId, deliveryKey: issued.deliveryKey, kind, detail }, CLASS_CHECK_MS).catch(() => {});
  }

  private deny(code: RejectCode): ChannelAnswer { return { decision: "deny", reason: requesterNotice(code) }; }

  private leftOpen(key: string, callId?: string) {
    if (this.lost) return;
    const held = this.recent.get(key);
    if (callId !== undefined && held === callId) return;
    this.recent.set(key, held === undefined ? callId ?? 1 : typeof held === "number" ? held + 1 : 2);
    if (this.recent.size > OPEN_CALL_KEYS) { this.recent.clear(); this.lost = true; }
  }

  private callOf(key: string, own?: string): string | undefined {
    const held = this.recent.get(key);
    if (own !== undefined) {
      if (held === own) this.recent.delete(key);
      return own;
    }
    if (typeof held === "number" && held > 1) this.recent.set(key, held - 1);
    else this.recent.delete(key);
    return typeof held === "string" ? held : undefined;
  }

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

  async check(body: unknown, run: string | undefined): Promise<ChannelAnswer> {
    if (this.stale(run)) return this.deny("unavailable");
    const call = readCall(body);
    if (!call) return this.deny("unavailable");
    this.first(call);
    const inputHash = hash(call.toolInput);
    const deferred = this.deferred;
    if (call.toolUseId && this.consumed.has(call.toolUseId)) return this.deny("needs-owner");
    if (deferred && call.toolUseId === deferred.callId) {
      if (deferred.phase !== "resuming" || !deferred.answer) return this.pending(call.toolName);
      this.consumed.add(deferred.callId);
      this.deferred = undefined;
      const changed = deferred.tool !== call.toolName || deferred.inputHash !== inputHash;
      const settle = (decision: string, kind: PermissionDelivery["kind"], detail: string, answer: ChannelAnswer) => {
        this.host.record({ event: "delivered", callId: deferred.callId, decision });
        this.delivery(deferred.issued, kind, detail);
        this.host.publish(this.view());
        return answer;
      };
      if (changed) return settle("changed", "stale", "Headless: the resumed call differs from the call the owner answered; it was denied.", this.deny("needs-owner"));
      if (deferred.answer.decision === "deny")
        return settle("deny", "receipt", "Headless: the owner's refusal was returned to the resumed call.", { decision: "deny", reason: deferred.answer.reason ?? OWNER_DENIED });
      let reply: ChannelReply | undefined;
      if (deferred.sessionRoot) {
        try { reply = await this.ask({ op: "resume", sessionRoot: deferred.sessionRoot, ...(deferred.issued ?? {}), call }, CLASS_CHECK_MS); }
        catch { reply = undefined; }
      }
      if (this.stale(run)) {
        this.retireCall("resume-ended", deferred);
        return this.deny("unavailable");
      }
      if (reply?.result !== "ok") {
        const reason = reply?.result === "withheld" ? reply.reason : "unavailable";
        return settle("withheld", "stale", `Headless: the owner's allow was withheld at the resume (${reason}); the call was denied as unavailable.`, this.deny("unavailable"));
      }
      return settle("allow", "receipt", "Headless: the owner's allow was returned to the resumed call.", { decision: "allow" });
    }
    if (deferred) return this.pending(call.toolName);
    let reply: ChannelReply;
    try { reply = await this.ask({ op: "class", call }, CLASS_CHECK_MS); }
    catch { return this.deny("unavailable"); }
    if (this.stale(run)) return this.deny("unavailable");
    if (reply.result === "not-served" || reply.result === "none") {
      this.leftOpen(callKey(call, inputHash), call.toolUseId);
      return { decision: "none" };
    }
    if (reply.result === "deny") {
      if (reply.interruptClass && reply.interruptClass !== "undeliverable") {
        this.host.record({ event: "owner-denied", tool: call.toolName, interruptClass: reply.interruptClass, reason: "no-decision" });
        this.tell(reply.interruptClass, reply.decisionId);
      }
      return this.deny(reply.code);
    }
    if (reply.result !== "owner") return this.deny("unavailable");
    if (call.agentId || !call.toolUseId || !this.nativeSessionId || this.deferred) {
      this.host.record({ event: "owner-denied", tool: call.toolName, interruptClass: reply.interruptClass, reason: call.agentId ? "subagent" : "no-call-id" });
      this.delivery(reply, "refusal", "Headless: this call cannot wait for the owner; it was denied with needs-owner.");
      this.tell(reply.interruptClass, reply.decisionId);
      return this.deny("needs-owner");
    }
    const since = this.now();
    this.deferred = {
      callId: call.toolUseId, tool: call.toolName, inputHash, interruptClass: reply.interruptClass, rule: reply.rule,
      ...(reply.decisionId && reply.deliveryKey ? { issued: { decisionId: reply.decisionId, deliveryKey: reply.deliveryKey } } : {}),
      ...(reply.sessionRoot ? { sessionRoot: reply.sessionRoot } : {}),
      since, expiresAt: since + DEFERRAL_RETENTION_MS, phase: "deferring",
    };
    this.host.record({
      event: "deferred", callId: call.toolUseId, tool: call.toolName, interruptClass: reply.interruptClass, rule: reply.rule,
      ...(reply.decisionId ? { decisionId: reply.decisionId } : {}), expiresAt: new Date(since + DEFERRAL_RETENTION_MS).toISOString(),
    });
    this.delivery(reply, "intent", "Headless: the call was deferred; it waits for the owner's answer.");
    return { decision: "defer", reason: DEFERRED_REASON };
  }

  async request(body: unknown, run: string | undefined): Promise<ChannelAnswer> {
    if (this.stale(run)) return this.deny("unavailable");
    const call = readCall(body);
    if (!call) return this.deny("unavailable");
    this.first(call);
    const inputHash = hash(call.toolInput);
    const callId = this.callOf(callKey(call, inputHash), call.toolUseId);
    if (this.deferred) return this.pending(call.toolName);
    const requestId = `headless:${this.host.sessionId}:${callId ?? `r${++this.requests}-${inputHash.slice(0, 24)}`}`;
    const forwarded: ChannelCall = { toolName: call.toolName, toolInput: call.toolInput, ...(callId ? { toolUseId: callId } : {}), ...(call.agentId ? { agentId: call.agentId } : {}) };
    let reply: ChannelReply;
    try { reply = await this.ask({ op: "decide", call: forwarded, requestId }, DECIDE_MS); }
    catch { return this.deny("unavailable"); }
    if (this.stale(run)) {
      this.delivery("decisionId" in reply ? reply : undefined, "refusal", "Headless: the provider run that made the call ended while the call was decided; the verdict never reached the call, which was denied as unavailable.");
      return this.deny("unavailable");
    }
    if (reply.result === "not-served") return { decision: "none" };
    if (reply.result === "allow") return { decision: "allow" };
    if (reply.result !== "deny") return this.deny("unavailable");
    if (reply.interruptClass) this.tell(reply.interruptClass === "undeliverable" ? undefined : reply.interruptClass, reply.decisionId);
    return this.deny(reply.code);
  }

  exited(exitCode: number): boolean {
    this.recent.clear();
    this.running = false;
    const deferred = this.deferred;
    if (!deferred) return false;
    if (deferred.phase === "deferring" && exitCode === 0 && this.nativeSessionId) {
      deferred.phase = "waiting";
      deferred.promptId = this.host.openPrompt({
        id: 0, kind: "permission", source: "protocol", acceptsText: true, hash: hash({ v: 1, callId: deferred.callId, tool: deferred.tool, input: deferred.inputHash }),
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
    this.retireCall(deferred.phase === "resuming" ? "resume-ended" : "provider-exited");
    return false;
  }

  waiting(): boolean { return this.deferred?.phase === "waiting"; }

  owns(promptId: number, requestId: string): boolean {
    return this.answers.has(requestId) || (this.deferred?.promptId === promptId && this.deferred.phase === "waiting");
  }

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
    this.delivery(deferred.issued, "intent", `Headless: the owner ${decision === "allow" ? "allowed the call once" : "refused the call"}; the session resumes.`);
    this.host.publish(this.view());
    this.runs++;
    this.running = true;
    this.lost = false;
    try {
      this.host.resume(this.nativeSessionId!);
      this.continueOwed = true;
    } catch {
      this.retireCall("resume-failed");
      this.host.end();
    }
    return receipt;
  }

  retire(reason: "stopped" | "expired") {
    if (!this.deferred) return;
    const waiting = this.deferred.phase === "waiting";
    this.retireCall(reason);
    if (waiting) this.host.end();
  }

  takeContinue(): boolean {
    const owed = this.continueOwed;
    this.continueOwed = false;
    return owed;
  }

  private retireCall(reason: string, deferred = this.deferred) {
    if (!deferred) return;
    if (this.deferred === deferred) this.deferred = undefined;
    if (deferred.promptId !== undefined && deferred.phase === "waiting") this.host.closePrompt(deferred.promptId, OWNER_DENY);
    this.host.record({ event: "retired", callId: deferred.callId, reason });
    this.delivery(deferred.issued, "refusal", deferred.answer
      ? `Headless: the deferred call was retired before the owner's answer reached it (${reason}).`
      : `Headless: the deferred call was retired unanswered (${reason}).`);
    this.host.publish(this.view());
  }

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
