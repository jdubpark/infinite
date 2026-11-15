/**
 * The permission agent's decision core: class rules, qualification, raise rules, readiness and the
 * model turns. It records nothing and delivers nothing; the pipeline does both.
 */
import { createHash } from "node:crypto";
import {
  PermissionReviewHeld,
  type PermissionAgentCore,
  type PermissionEvidence,
  type PermissionReadiness,
  type PermissionRequest,
  type PermissionReview,
  type PermissionReviewContext,
} from "./permission-agent-types.js";
import type { PermissionTier } from "./evidence/permission-journal.js";
import { profileIdentity, type PermissionAgentSettings } from "./permission-agent-config.js";
import { classify, classRulesDigest, qualify, raise, readRequest, withRealRoots, type HostRuleFacts } from "./permission-classes.js";
import type { PathResolver } from "./permission-shell.js";
import { familyOf } from "./permission-families.js";
import { INTERRUPT_CLASSES, PERMISSION_POLICY_TEXT, type InterruptClass } from "./permission-policy.js";
import { canonicalJson } from "./evidence/crypto.js";
import {
  parseReport,
  reportJsonSchema,
  tierTexts,
  turnPrompt,
  turnSystemText,
  type PermissionReport,
  type PermissionTierName,
  type PermissionTurnLauncher,
  type ReportOptions,
} from "./permission-reviewer.js";
import type { TeamModelProfile } from "./team-types.js";

/** Every fresh review ends inside this window. */
export const REVIEW_WINDOW_MS = 5 * 60 * 1000;
/** A strong turn without a valid report is retried once inside the window. */
const STRONG_ATTEMPTS = 2;

/** A rate with its 95% Wilson interval. `rate` is null when no case is relevant; the interval is then [0, 1]. */
export interface RateFigure { count: number; relevant: number; rate: number | null; lower: number; upper: number }

/** The latest replay result for one binding, as readiness reads it. */
export interface ReplayResultSummary {
  id: string;
  binding: string;
  finishedAt: string;
  cases: number;
  /** Cases labelled should-reject or should-reach-owner that got allow, over all such cases. */
  missRate: RateFigure;
}

export interface ReplayResults {
  latest(binding: string): ReplayResultSummary | undefined;
}

export interface PermissionCoreOptions {
  settings: PermissionAgentSettings | (() => PermissionAgentSettings);
  launcher: PermissionTurnLauncher;
  results?: ReplayResults;
  facts?: HostRuleFacts;
  /**
   * The host's real-path resolver. With it the class and raise rules judge real paths, so a link inside
   * the session root cannot hide a target outside it. A replay never uses it: it reads nothing from disk.
   */
  resolvePath?: PathResolver;
  /** "replay" marks turn usage as a measurement. */
  purpose?: "review" | "replay";
  windowMs?: number;
  now?: () => number;
}

export interface PermissionAgentCoreService extends PermissionAgentCore {
  /** The pair of policy text and tier profiles a replay result belongs to. Any change gives another value. */
  binding(): string;
  settings(): PermissionAgentSettings;
}

/** Everything a replay result depends on. */
export interface BindingParts {
  policy: string;
  tiers: readonly string[];
  classes: readonly string[];
  classRules: string;
  light: TeamModelProfile | undefined;
  strong: readonly TeamModelProfile[];
}

export function bindingDigest(parts: BindingParts): string {
  return createHash("sha256").update(canonicalJson({
    policy: parts.policy,
    tiers: [...parts.tiers],
    classes: [...parts.classes],
    classRules: parts.classRules,
    light: parts.light ? profileIdentity(parts.light) : null,
    strong: parts.strong.map(profileIdentity),
  })).digest("hex");
}

/** The binding of a replay result: the current policy text, tier texts, classes and class rules, and the tier profiles. */
export function permissionBinding(settings: PermissionAgentSettings, facts: HostRuleFacts = {}): string {
  return bindingDigest({ policy: PERMISSION_POLICY_TEXT, tiers: tierTexts(), classes: INTERRUPT_CLASSES, classRules: classRulesDigest(facts), light: settings.light, strong: settings.strong });
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function createPermissionAgentCore(options: PermissionCoreOptions): PermissionAgentCoreService {
  const settingsOf = () => typeof options.settings === "function" ? options.settings() : options.settings;
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? REVIEW_WINDOW_MS;
  const purpose = options.purpose ?? "review";
  const facts = options.facts ?? {};
  const launcher = options.launcher;
  const real = purpose === "replay" ? undefined : options.resolvePath;
  /** The request and its reading as the host rules judge them. */
  const read = (request: PermissionRequest) => {
    const judged = real ? withRealRoots(request, real) : request;
    return { judged, reading: readRequest(judged, real) };
  };

  const tierRecord = (tier: PermissionTierName, profile: TeamModelProfile, startedAt: string, endedAt: string): PermissionTier =>
    ({ tier, profileId: profile.id, family: familyOf(profile) ?? "unknown", startedAt, endedAt });

  /** One turn. A held turn throws; a turn without a valid report returns undefined. */
  async function turn(tier: PermissionTierName, profile: TeamModelProfile, request: PermissionRequest, context: PermissionReviewContext,
    report: ReportOptions, deadline: number, evidence: PermissionEvidence | undefined, tiers: PermissionTier[]): Promise<PermissionReport | undefined> {
    const timeoutMs = deadline - now();
    if (timeoutMs <= 0 || context.signal?.aborted) return undefined;
    const outcome = await launcher.run({
      purpose, tier, profile, timeoutMs, signal: context.signal,
      ...(context.held ? { held: context.held } : {}),
      system: turnSystemText(report, context),
      prompt: turnPrompt(request, context, evidence),
      schema: reportJsonSchema(report),
    });
    if (!outcome.ok && outcome.failure === "held") throw new PermissionReviewHeld();
    if (outcome.startedAt && outcome.endedAt) tiers.push(tierRecord(tier, profile, outcome.startedAt, outcome.endedAt));
    return outcome.ok ? parseReport(outcome.output, report) : undefined;
  }

  const unavailable = (tiers: PermissionTier[], note: string): PermissionReview => ({ verdict: "reject", code: "unavailable", note, tiers });

  const core: PermissionAgentCoreService = {
    settings: settingsOf,
    binding: () => permissionBinding(settingsOf(), facts),
    familyOf,
    classify: (request, interruptClasses) => { const { judged, reading } = read(request); return classify(judged, interruptClasses, facts, reading); },
    qualify,
    raise: (request, context) => { const { judged, reading } = read(request); return raise(judged, context, reading, facts); },

    readiness(): PermissionReadiness {
      const settings = settingsOf();
      const reasons: string[] = [];
      if (!settings.light) reasons.push("No light profile is configured. Set permissionAgent.light, or teams.lineup.permissionReviewer.");
      else if (!launcher.supports(settings.light)) reasons.push(`The light profile ${settings.light.id} uses ${settings.light.provider}, which has no tool-less reviewer launch on this host.`);
      const counted = settings.strong.filter(profile => launcher.supports(profile) && familyOf(profile) !== undefined);
      const families = new Set(counted.map(profile => familyOf(profile)!));
      if (families.size < 2) {
        const skipped = settings.strong.filter(profile => !counted.includes(profile)).map(profile => profile.id);
        reasons.push(`Strong profiles come from ${families.size} model ${families.size === 1 ? "family" : "families"}; at least two are needed.${skipped.length ? ` Not counted (no tool-less launch or unknown family): ${skipped.join(", ")}.` : ""}`);
      }
      const latest = options.results?.latest(permissionBinding(settings, facts));
      if (!latest) reasons.push("No replay result exists for the current policy and tier profiles. Run infinite permissions replay --set FILE.");
      else {
        if (latest.cases < settings.minCases) reasons.push(`The replay result has ${latest.cases} labelled cases; at least ${settings.minCases} are needed.`);
        if (latest.missRate.upper > settings.maxMissRate)
          reasons.push(`The miss rate's upper bound is ${percent(latest.missRate.upper)}, above the threshold of ${percent(settings.maxMissRate)}.`);
      }
      return { ready: reasons.length === 0, reasons };
    },

    async review(request, context): Promise<PermissionReview> {
      const settings = settingsOf();
      const deadline = now() + windowMs;
      const tiers: PermissionTier[] = [];
      const classes = context.interruptClasses.filter((value): value is InterruptClass => (INTERRUPT_CLASSES as readonly string[]).includes(value));

      // A raised request never gets a light verdict, and a request that cannot be allowed has nothing for the light tier.
      if (context.raised.length === 0 && context.canAllow && settings.light && launcher.supports(settings.light)) {
        const light = await turn("light", settings.light, request, context, { tier: "light", canAllow: true, canCollect: false, classes }, deadline, request.evidence, tiers);
        if (light?.verdict === "allow") return { verdict: "allow", note: light.note, tiers };
        // Refer, no report or a failed turn: the strong tier decides. The light tier can never reject.
      }

      if (context.requesterFamily === undefined) return unavailable(tiers, "The host cannot establish the requester's model family, so no strong tier qualifies.");
      const candidates = settings.strong.filter(profile => {
        const family = familyOf(profile);
        return family !== undefined && family !== context.requesterFamily && launcher.supports(profile);
      });
      if (!candidates.length) return unavailable(tiers, "No strong profile from a family other than the requester's is available.");

      let evidence = request.evidence;
      let collected = false;
      let candidate = 0;
      for (let attempt = 0; attempt < STRONG_ATTEMPTS && now() < deadline && !context.signal?.aborted;) {
        const profile = candidates[Math.min(candidate, candidates.length - 1)];
        const report: ReportOptions = { tier: "strong", canAllow: context.canAllow, canCollect: Boolean(context.collect) && !collected, classes };
        const strong = await turn("strong", profile, request, context, report, deadline, evidence, tiers);
        if (strong?.verdict === "evidence") {
          collected = true;
          try { evidence = await context.collect!(strong.paths.slice(0, 8)); }
          catch { evidence = { files: [], limitations: ["The host could not collect the requested paths."], digest: "" }; }
          continue;
        }
        if (strong?.verdict === "allow" && context.canAllow) return { verdict: "allow", note: strong.note, tiers };
        if (strong?.verdict === "reject") return { verdict: "reject", code: strong.code, note: strong.note, ...(strong.repeats ? { repeats: strong.repeats } : {}), tiers };
        if (strong?.verdict === "owner") return { verdict: "owner", interruptClass: strong.interruptClass, note: strong.note, tiers };
        // No valid report: retry inside the window, on the next qualifying profile when there is one.
        attempt++;
        candidate++;
      }
      return unavailable(tiers, "No qualifying strong model gave a valid report inside the review window.");
    },
  };
  return core;
}
