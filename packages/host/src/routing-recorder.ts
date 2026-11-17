import type { AutonomyMode } from "./autonomy.js";
import { appendRunEvent } from "./run-events.js";
import { screen } from "./routing-choice.js";
import {
  AUTO_LOG, DECISION_BUDGET_MS, decideAutoStart, evaluateStart, periodEnd, REQUIRED_MODULES, startFrame,
  type AutoFailure, type RouterStart,
} from "./routing-auto.js";
import { effectiveRouting, pinRouting, type TeamRouting } from "./routing-policy.js";
import { fallbackProfile, PROFILE_MESSAGES } from "./routing-rules.js";
import { decisionKey, insertDecision, PAYLOAD_LIMIT_BYTES, readDecision } from "./routing-store.js";
import type { TeamRunRouting } from "./routing-types.js";
import { fixedRuleFailure, type TeamLineup, type TeamModelProfile } from "./team-types.js";
import type { EvidenceStore } from "./evidence/store.js";
import { TeamError } from "./team-workspace.js";

export { DECISION_BUDGET_MS } from "./routing-auto.js";
export type { RouterStart } from "./routing-auto.js";

/** The fixed log texts of the shadow recorder. Each names no id and no value. */
const LOG = {
  unavailable: "Routing shadow decision skipped: the evidence store is unavailable.",
  budget: `Routing shadow decision skipped: it took longer than ${DECISION_BUDGET_MS} ms.`,
  failed: "Routing shadow decision failed.",
  tooLarge: "Routing shadow decision skipped: its details are over the size limit.",
} as const;

type Reason = keyof typeof LOG;

/**
 * Records the router's pick for the implementer of a task, when the task starts, in shadow; and applies the pick of an
 * `auto` run. A shadow start writes at most one `recorded` row per run, revision, and task. An auto start writes one
 * `pending` row before its member exists. Neither throws into a run.
 */
export class RoutingRecorder {
  private readonly store: EvidenceStore;
  private readonly now: () => string;
  private readonly clock: () => number;
  private readonly log: (line: string) => void;
  private readonly logged = new Set<Reason>();
  private readonly autoLogged = new Set<keyof typeof AUTO_LOG>();

  constructor(options: { store: EvidenceStore; now?: () => string; clock?: () => number; log?: (line: string) => void }) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
    this.clock = options.clock ?? (() => performance.now());
    this.log = options.log ?? (line => console.warn(line));
  }

  /**
   * Step 1's pin. A saved `auto` mode, or the autonomous default (no saved mode in an autonomous project), reads the period
   * end: before it is stored, the shadow pin; with it, the `auto` pin, unless no implementer passes the fixed rules. A saved
   * `auto` then refuses with 409 `routing-no-eligible-profile`; the autonomous default logs once and pins shadow.
   * A store failure gives the shadow pin and one log line.
   */
  pin(saved: TeamRouting | undefined, autonomy: AutonomyMode, lineup: TeamLineup | undefined, projectId: string): TeamRunRouting | undefined {
    const shadowPin = () => pinRouting(saved, autonomy, lineup);
    const effective = effectiveRouting(saved, autonomy);
    // The same condition as pinRouting's `auto`: a saved auto mode, or no saved mode in an autonomous project.
    const auto = saved?.mode === "auto" || (saved?.mode === undefined && autonomy === "autonomous");
    if (effective.mode !== "shadow" || !effective.knobs.points.includes("start") || lineup === undefined || !auto) return shadowPin();

    let end: string | undefined;
    try {
      end = periodEnd(this.store, projectId, this.now());
    } catch {
      this.autoOnce("pin");
      return shadowPin();
    }
    if (end === undefined) return shadowPin();

    const pin = pinRouting(saved, autonomy, lineup, end);
    if (pin?.mode === "auto" && !screen(lineup, pin.knobs, new Set()).some(item => item.removed === undefined)) {
      if (saved?.mode === "auto") throw new TeamError(409, "routing-no-eligible-profile", PROFILE_MESSAGES.noEligible);
      this.autoOnce("uncovered");
      return shadowPin();
    }
    return pin;
  }

  /** Never throws. Writes at most one shadow row. An `auto` pin returns at once: its start is `applyStart`'s. */
  recordStart(input: RouterStart): void {
    try {
      this.record(input);
    } catch {
      this.once("failed");
    }
  }

  /**
   * The profile an `auto` run's task starts on, and `task.routing` set to it. Undefined unless the run is `auto`-pinned.
   * A revoked run starts on the fallback profile without a run line, as the revoke wrote one. A fallback writes one run line.
   * It throws only when no implementer passes the fixed rules, which `pin` refuses before a run exists.
   */
  applyStart(input: RouterStart): TeamModelProfile | undefined {
    const { run, task } = input;
    const routing = run.routing;
    const lineup = run.lineup;
    if (routing?.mode !== "auto" || lineup === undefined) return undefined;
    if (run.routingRevokedAt !== undefined) {
      const profile = fallbackProfile(run, task);
      task.routing = { profileId: profile.id, by: "fallback" };
      return profile;
    }
    const kept = task.routing === undefined ? undefined : lineup.implementers.find(profile => profile.id === task.routing?.profileId);
    if (kept !== undefined && fixedRuleFailure(lineup, routing.knobs, kept) === undefined) return kept;

    const decision = decideAutoStart(this.store, input, this.now, this.clock);
    task.routing = { profileId: decision.profile.id, by: decision.by };
    if (decision.by === "fallback") {
      appendRunEvent(run, `Host routing could not choose a profile for task ${task.id}; it is assigned ${decision.profile.label}.`);
      this.autoOnce(decision.reason);
    }
    return decision.profile;
  }

  private once(reason: Reason): void {
    if (this.logged.has(reason)) return;
    this.logged.add(reason);
    this.log(LOG[reason]);
  }

  private autoOnce(reason: AutoFailure | "pin" | "uncovered"): void {
    if (this.autoLogged.has(reason)) return;
    this.autoLogged.add(reason);
    this.log(AUTO_LOG[reason]);
  }

  private record(input: RouterStart): void {
    const { run, task } = input;
    const routing = run.routing;
    if (routing === undefined || routing.mode === "auto" || run.lineup === undefined || !routing.knobs.points.includes("start")) return;
    const modules = this.store.status().modules;
    if (REQUIRED_MODULES.some(name => modules[name] !== "ready")) {
      this.once("unavailable");
      return;
    }

    const frame = startFrame(input);
    const started = this.clock();
    const decided = this.store.read(db => {
      // The task's blind index, never its plain id: the key and the seed are stored as plain columns.
      const taskKey = db.index("task", task.id);
      const key = decisionKey(run.id, run.revision, taskKey, "start", 1);
      const existing = readDecision(db, key);
      if (existing !== undefined) return { existing };
      return evaluateStart(db, input, frame, { taskKey, key }, this.now(), false);
    });
    if (decided === undefined || "existing" in decided) return;

    const elapsed = this.clock() - started;
    if (elapsed > DECISION_BUDGET_MS) {
      this.once("budget");
      return;
    }
    const { row, payload } = decided;
    payload.elapsedMs = Math.round(elapsed);
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PAYLOAD_LIMIT_BYTES) {
      this.once("tooLarge");
      return;
    }
    this.store.tryWrite(tx => {
      insertDecision(tx, row, payload);
    });
  }
}
