/**
 * Interactive delivery of the permission agent's decisions. A requester adapter builds a target for one
 * pending dialog; this service asks the pipeline for a decision and delivers it with the live checks.
 *
 * The service decides nothing itself. It can only leave a request with the owner, refuse to deliver, or
 * deliver the pipeline's recorded verdict through a recognised one-shot option. Before a key is sent it
 * records an intent in its own durable ledger and in the decision journal, and a request whose delivery
 * result is unknown is never delivered again, also after a restart.
 */
import type { EvidenceStore } from "./evidence/store.js";
import type { EvidenceModule, EvidenceTx } from "./evidence/types.js";
import type { PermissionDeliveryService, PermissionHandled, PermissionInteractiveTarget, PermissionPipeline } from "./permission-agent-types.js";

/** The last recorded delivery state of one raised request. */
export type DeliveryLedgerState = "intent" | "receipt" | "refusal" | "uncertain" | "stale";

/** Durable delivery state by request id. Both methods throw when the state cannot be read or written. */
export interface PermissionDeliveryLedger {
  get(requestId: string): { decisionId: string; state: DeliveryLedgerState } | undefined;
  set(requestId: string, entry: { sessionId: string; decisionId: string; state: DeliveryLedgerState }): void;
}

const TABLE = "permission_delivery_requests";
const STATES: readonly DeliveryLedgerState[] = ["intent", "receipt", "refusal", "uncertain", "stale"];

/** The delivery ledger's table in the host's evidence store. It belongs to no run, so it has no run-deletion hook. */
export const permissionDeliveryModule: EvidenceModule = {
  name: "permission-delivery",
  version: 1,
  readVersion: 1,
  migrate(tx: EvidenceTx) {
    tx.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, `
      + "decision_id TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL)");
  },
  counts(db) {
    return { requests: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE}`)?.n ?? 0 };
  },
};

export class EvidenceDeliveryLedger implements PermissionDeliveryLedger {
  constructor(private readonly store: EvidenceStore, private readonly now: () => number = Date.now) {
    if (store.status().modules[permissionDeliveryModule.name] !== "ready")
      throw new TypeError("The permission-delivery evidence module must be registered and ready.");
  }
  get(requestId: string) {
    const row = this.store.read(db => db.get<{ decision_id: string; state: string }>(
      `SELECT decision_id, state FROM ${TABLE} WHERE request_id=?`, requestId));
    if (!row) return undefined;
    if (!STATES.includes(row.state as DeliveryLedgerState)) throw new TypeError("A stored delivery state is invalid.");
    return { decisionId: row.decision_id, state: row.state as DeliveryLedgerState };
  }
  set(requestId: string, entry: { sessionId: string; decisionId: string; state: DeliveryLedgerState }) {
    if (!STATES.includes(entry.state)) throw new TypeError("A delivery state is invalid.");
    this.store.write(tx => {
      tx.run(`INSERT INTO ${TABLE} (request_id, session_id, decision_id, state, at) VALUES (?,?,?,?,?) `
        + "ON CONFLICT(request_id) DO UPDATE SET decision_id=excluded.decision_id, state=excluded.state, at=excluded.at",
      requestId, entry.sessionId, entry.decisionId, entry.state, new Date(this.now()).toISOString());
    });
  }
}

/** A requester adapter that hands pending dialogs of its sessions to the service. */
export interface PermissionDeliverySource {
  /** Whether the adapter would hand this pending dialog to the service now. Synchronous and cheap: the notifier asks it. */
  claims(sessionId: string, promptId: number): boolean;
}

type Options = {
  /** Read at each use: the pipeline can be wired after this service. Without one nothing is decided. */
  pipeline: () => PermissionPipeline | undefined;
  /** Without a ledger nothing is delivered, because an unknown result could not be kept from repeating. */
  ledger: PermissionDeliveryLedger | undefined;
  now?: () => number;
};
type Holder = "agent" | "owner";
type Finished = { handled: PermissionHandled; at: number };

/** A result that leaves the request with the owner is tried again after this long, never sooner. */
const RETRY_NOT_HANDLED_MS = 30_000;
const MEMORY_LIMIT = 2048;
const NOT_WIRED = "The permission agent is not active on this host.";

const holderOf = (handled: PermissionHandled): Holder =>
  handled.handled && ["allowed", "rejected", "stale"].includes(handled.result) ? "agent" : "owner";

export class InteractivePermissionDelivery implements PermissionDeliveryService {
  private readonly inFlight = new Map<string, Promise<PermissionHandled>>();
  private readonly finished = new Map<string, Finished>();
  /** The holder of each pending dialog by `sessionId:promptId`, for the notifier. */
  private readonly prompts = new Map<string, Holder>();
  /** Requests whose delivery result is unknown in this process, kept even when the ledger write failed. */
  private readonly unknown = new Set<string>();
  private readonly sources = new Set<PermissionDeliverySource>();
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  /** Whether a pipeline and a ledger are wired, so that the service can decide and deliver anything. */
  active(): boolean { return Boolean(this.options.pipeline() && this.options.ledger); }

  /** Registers a requester adapter for `holder`. Returns its removal. */
  addSource(source: PermissionDeliverySource): () => void {
    this.sources.add(source);
    return () => { this.sources.delete(source); };
  }

  handle(target: PermissionInteractiveTarget): Promise<PermissionHandled> {
    const id = target.request.id;
    const running = this.inFlight.get(id);
    if (running) return running;
    const done = this.finished.get(id);
    if (done && (done.handled.handled || this.now() - done.at < RETRY_NOT_HANDLED_MS)) return Promise.resolve(structuredClone(done.handled));
    const operation = this.run(target).catch((): PermissionHandled => ({ handled: false, reason: "The permission request could not be handled." }))
      .then(handled => this.remember(target, handled));
    this.inFlight.set(id, operation);
    void operation.finally(() => this.inFlight.delete(id));
    return operation;
  }

  holder(sessionId: string, promptId: number): "agent" | "owner" | "undecided" {
    if (!this.active()) return "owner";
    const known = this.prompts.get(`${sessionId}:${promptId}`);
    if (known) return known;
    for (const source of this.sources) {
      try { if (source.claims(sessionId, promptId)) return "undecided"; }
      catch { /* An adapter that cannot answer claims nothing. */ }
    }
    return "owner";
  }

  private promptKey(target: PermissionInteractiveTarget) {
    return target.request.prompt ? `${target.request.requester.sessionId}:${target.request.prompt.id}` : undefined;
  }

  private setHolder(target: PermissionInteractiveTarget, holder: Holder) {
    const key = this.promptKey(target);
    if (!key) return;
    this.prompts.delete(key);
    this.prompts.set(key, holder);
    while (this.prompts.size > MEMORY_LIMIT) this.prompts.delete(this.prompts.keys().next().value!);
  }

  private remember(target: PermissionInteractiveTarget, handled: PermissionHandled): PermissionHandled {
    this.setHolder(target, holderOf(handled));
    this.finished.delete(target.request.id);
    this.finished.set(target.request.id, { handled: structuredClone(handled), at: this.now() });
    while (this.finished.size > MEMORY_LIMIT) this.finished.delete(this.finished.keys().next().value!);
    return handled;
  }

  private async check(target: PermissionInteractiveTarget) {
    try { return await target.check(); }
    catch { return { ok: false as const, stale: false, reason: "The pending request could not be verified." }; }
  }

  private async run(target: PermissionInteractiveTarget): Promise<PermissionHandled> {
    const { request } = target;
    const pipeline = this.options.pipeline(), ledger = this.options.ledger;
    if (!pipeline || !ledger) return { handled: false, reason: NOT_WIRED };
    const served = pipeline.serves(request.requester.projectId);
    if (!served.served) return { handled: false, reason: served.reason === "not-ready" ? "The host is not ready to serve permission requests." : "No owner delegation covers this project." };

    // A request whose delivery result is unknown is never delivered again, also after a restart.
    let prior: ReturnType<PermissionDeliveryLedger["get"]>;
    try { prior = ledger.get(request.id); }
    catch { return { handled: false, reason: "The delivery record cannot be read." }; }
    if (this.unknown.has(request.id) || prior && (prior.state === "intent" || prior.state === "uncertain" || prior.state === "receipt")) {
      const live = await this.check(target);
      const decisionId = prior?.decisionId;
      return live.ok
        ? { handled: true, result: "undeliverable", ...(decisionId ? { decisionId } : {}), delivery: "uncertain" }
        : { handled: true, result: "stale", ...(decisionId ? { decisionId } : {}), delivery: "uncertain" };
    }

    const before = await this.check(target);
    if (!before.ok) return before.stale ? { handled: true, result: "stale" } : { handled: false, reason: before.reason };

    this.setHolder(target, "agent");
    let outcome;
    try { outcome = await pipeline.decide(request, target.signal ? { signal: target.signal } : undefined); }
    catch { return { handled: false, reason: "The permission agent could not decide the request." }; }
    switch (outcome.kind) {
      case "not-served": return { handled: false, reason: "No owner delegation covers this project." };
      case "owner": return { handled: true, result: "owner", decisionId: outcome.decisionId, interruptClass: outcome.interruptClass };
      case "undeliverable": return { handled: true, result: "undeliverable" };
      case "allow": return this.deliver(target, pipeline, ledger, outcome.decisionId, "accept", outcome.strongTier);
      case "reject": {
        const handled = await this.deliver(target, pipeline, ledger, outcome.decisionId, "reject", false, outcome.notice);
        return handled.handled ? { ...handled, code: outcome.code } : handled;
      }
    }
  }

  private async deliver(target: PermissionInteractiveTarget, pipeline: PermissionPipeline, ledger: PermissionDeliveryLedger,
    decisionId: string, choice: "accept" | "reject", strongTier: boolean, notice?: string): Promise<PermissionHandled> {
    const { request } = target, sessionId = request.requester.sessionId;
    const record = (kind: DeliveryLedgerState, detail?: string) => {
      try { pipeline.recordDelivery(decisionId, kind, detail); } catch { /* The ledger below still fences a repeat. */ }
    };
    const verdict = choice === "accept" ? "allowed" as const : "rejected" as const;
    const live = await this.check(target);
    if (!live.ok) {
      if (live.stale) { record("stale", live.reason); return { handled: true, result: "stale", decisionId }; }
      record("refusal", live.reason);
      return { handled: false, reason: live.reason };
    }
    let applicable = false;
    try { applicable = pipeline.applicable(decisionId); } catch { applicable = false; }
    if (!applicable) {
      record("refusal", "The decision's authority was retired before delivery.");
      return { handled: false, reason: "The decision's authority was retired before delivery." };
    }
    if (choice === "accept" && request.destructive && !strongTier) {
      record("refusal", "A request with the destructive flag is delivered only on a strong verdict.");
      return { handled: true, result: "undeliverable", decisionId, delivery: "refusal" };
    }
    const option = choice === "accept" ? live.accept : live.reject;
    if (option === undefined) {
      record("refusal", choice === "accept" ? "The dialog offers no recognised one-shot accept." : "The dialog offers no recognised one-shot reject.");
      return { handled: true, result: "undeliverable", decisionId, delivery: "refusal" };
    }

    // The intent is durable in both records before any key is sent. Without it nothing is sent.
    try {
      ledger.set(request.id, { sessionId, decisionId, state: "intent" });
      pipeline.recordDelivery(decisionId, "intent");
    } catch {
      try { ledger.set(request.id, { sessionId, decisionId, state: "refusal" }); } catch { this.unknown.add(request.id); }
      return { handled: true, result: "undeliverable", decisionId, delivery: "refusal" };
    }
    this.unknown.add(request.id);
    let answered: "delivered" | "refused" | "uncertain";
    try { answered = await target.answer(option, decisionId, choice === "reject" ? notice : undefined); }
    catch { answered = "uncertain"; }
    const kind: DeliveryLedgerState = answered === "delivered" ? "receipt" : answered === "refused" ? "refusal" : "uncertain";
    let stored = true;
    try { ledger.set(request.id, { sessionId, decisionId, state: kind }); } catch { stored = false; }
    record(kind);
    // Only a refusal that both records hold lets the same request be tried again.
    if (kind === "refusal" && stored) this.unknown.delete(request.id);

    if (answered === "delivered") return { handled: true, result: verdict, decisionId, delivery: "receipt" };
    const after = await this.check(target);
    if (answered === "refused") {
      if (after.ok) return { handled: true, result: "undeliverable", decisionId, delivery: "refusal" };
      if (after.stale) { record("stale", after.reason); return { handled: true, result: "stale", decisionId, delivery: "refusal" }; }
      return { handled: false, reason: after.reason };
    }
    // An uncertain delivery is never repeated. While the dialog is still open it goes to the owner.
    return after.ok
      ? { handled: true, result: "undeliverable", decisionId, delivery: "uncertain" }
      : { handled: true, result: "stale", decisionId, delivery: "uncertain" };
  }
}
