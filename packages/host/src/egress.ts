import { createHmac } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Config } from "./types.js";

/**
 * Agent egress through the host egress proxy (scripts/egress-proxy.mjs, deploy/ubuntu/egress.md).
 *
 * Each provider session gets proxy variables whose URL carries that session's credential: the user name is
 * `PROJECT.SESSION` and the password `v1.EXPIRES.MAC`, an HMAC-SHA256 under a key that only the host and proxy
 * accounts can read. The proxy verifies it without state. The key never enters a session's environment.
 */
const CREDENTIAL_CONTEXT = "infinite-egress/v1";
/** A session's credential lasts as long as a long session might; the proxy accepts at most 31 days. */
export const SESSION_CREDENTIAL_SECONDS = 30 * 24 * 60 * 60;
/** Host-run commands mint a fresh credential per command. */
export const HOST_CREDENTIAL_SECONDS = 24 * 60 * 60;
export const HOST_IDENTITY = { project: "_host", session: "host" } as const;
export const EGRESS_NO_PROXY = "localhost,127.0.0.1,::1";
const EGRESS_ENVIRONMENT = {
  HTTPS_PROXY: "HTTPS_PROXY",
  HTTP_PROXY: "HTTP_PROXY",
  httpsProxy: "https_proxy",
  httpProxy: "http_proxy",
  NO_PROXY: "NO_PROXY",
  noProxy: "no_proxy",
  nodeUseEnvProxy: "NODE_USE_ENV_PROXY",
} as const;
export const EGRESS_ENVIRONMENT_NAMES: readonly string[] = Object.freeze(Object.values(EGRESS_ENVIRONMENT));
const PROJECT_ID = /^[a-z0-9-]{1,80}$/;
const PROJECT_LABEL = /^(?:_host|_none|[a-z0-9-]{1,80})$/;
const SESSION_LABEL = /^[A-Za-z0-9-]{1,64}$/;
/** The summary's project names: projects, the reserved host and no-project labels, and requests without credentials. */
export const EGRESS_PROJECT = /^(?:_unauthenticated|_host|_none|[a-z0-9-]{1,80})$/;
const KEY_BYTES = 32;
const MAX_SUMMARY_BYTES = 16 * 1024 * 1024;
/** Non-secret settings a host process passes to the workers it starts. */
const WORKER_PROXY_URL = "INFINITE_EGRESS_PROXY_URL";
const WORKER_KEY_FILE = "INFINITE_EGRESS_KEY_FILE";

function loopbackProxyUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !url.port) return false;
  if (value !== `http://${url.host}` && value !== `http://${url.host}/`) return false;
  return url.hostname === "[::1]" || /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.test(url.hostname);
}

export const egressConfigSchema = z.object({
  proxyUrl: z.string().refine(loopbackProxyUrl, "egress.proxyUrl must be http:// to a loopback IP address with a port, and nothing else"),
  keyPath: z.string().refine(isAbsolute, "egress.keyPath must be absolute"),
  summaryPath: z.string().refine(isAbsolute, "egress.summaryPath must be absolute").optional(),
}).strict();
export type EgressConfig = z.infer<typeof egressConfigSchema>;
export interface EgressIdentity { project: string; session: string }

export class EgressKeyError extends Error {
  constructor(readonly reason: "unavailable" | "not-regular-file" | "permissions" | "length") {
    super(`Egress key ${reason}`);
  }
}

/** The shared key: a regular 32-byte file owned by root or this account, that other users cannot read and the group cannot write. */
export function readEgressKey(path: string): Buffer {
  let before: ReturnType<typeof lstatSync>;
  try { before = lstatSync(path); } catch { throw new EgressKeyError("unavailable"); }
  if (!before.isFile()) throw new EgressKeyError("not-regular-file");
  if ((before.mode & 0o027) !== 0 || (before.uid !== 0 && before.uid !== process.getuid?.())) throw new EgressKeyError("permissions");
  if (before.size !== KEY_BYTES) throw new EgressKeyError("length");
  let fd: number | undefined;
  try {
    try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { throw new EgressKeyError("unavailable"); }
    const after = fstatSync(fd);
    if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev || (after.mode & 0o027) !== 0) throw new EgressKeyError("permissions");
    const key = Buffer.alloc(KEY_BYTES + 1);
    const length = readSync(fd, key, 0, key.length, 0);
    if (length !== KEY_BYTES) throw new EgressKeyError("length");
    return key.subarray(0, KEY_BYTES);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The proxy credential for one identity, expiring at `expiresAt` (Unix seconds). */
export function egressCredential(key: Buffer, project: string, session: string, expiresAt: number) {
  if (!PROJECT_LABEL.test(project) || !SESSION_LABEL.test(session) || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)
    throw new Error("Invalid egress identity");
  const expires = String(expiresAt);
  const mac = createHmac("sha256", key).update(`${CREDENTIAL_CONTEXT}\n${project}\n${session}\n${expires}`, "utf8").digest("base64url");
  return { username: `${project}.${session}`, password: `v1.${expires}.${mac}` };
}

function proxyEnvironment(value: string): Record<string, string> {
  return {
    [EGRESS_ENVIRONMENT.HTTPS_PROXY]: value,
    [EGRESS_ENVIRONMENT.HTTP_PROXY]: value,
    [EGRESS_ENVIRONMENT.httpsProxy]: value,
    [EGRESS_ENVIRONMENT.httpProxy]: value,
    [EGRESS_ENVIRONMENT.NO_PROXY]: EGRESS_NO_PROXY,
    [EGRESS_ENVIRONMENT.noProxy]: EGRESS_NO_PROXY,
    [EGRESS_ENVIRONMENT.nodeUseEnvProxy]: "1",
  };
}

/** Remove inherited proxy state before applying the current egress policy. */
export function clearEgressEnvironment(env: Record<string, string | undefined>): void {
  for (const name of EGRESS_ENVIRONMENT_NAMES) delete env[name];
}

/** The six proxy variables and Node's opt-in flag for one identity. Loopback stays direct. */
export function egressProxyEnvironment(proxyUrl: string, key: Buffer, identity: EgressIdentity, lifetimeSeconds: number, nowMs = Date.now()): Record<string, string> {
  const { username, password } = egressCredential(key, identity.project, identity.session, Math.floor(nowMs / 1000) + lifetimeSeconds);
  const value = `http://${username}:${password}@${new URL(proxyUrl).host}`;
  return proxyEnvironment(value);
}

/**
 * The six proxy variables with no credential, for a configured host that cannot mint one: every request through the
 * proxy is answered 407, so nothing reaches the network by accident and local work is unaffected.
 */
export function egressUncredentialedEnvironment(proxyUrl: string): Record<string, string> {
  const value = `http://${new URL(proxyUrl).host}`;
  return proxyEnvironment(value);
}

/** A session's identity: its project, or `_none` when it has no valid one. */
export function sessionEgressIdentity(projectId: string | undefined, sessionId: string): EgressIdentity {
  return { project: projectId && PROJECT_ID.test(projectId) ? projectId : "_none", session: sessionId };
}

let hostEgress: { proxyUrl: string; keyPath: string; key?: Buffer; warned: boolean } | undefined;

/**
 * Called once per host process after its configuration is read. With `autonomy.boundary.egress`, workers this
 * process starts inherit the proxy address and key path (never the key), and host-run team commands get the proxy
 * variables with the host identity. Without it, both are cleared, so the environment is what it was before.
 */
export function installHostEgress(config: Pick<Config, "autonomy">, env: NodeJS.ProcessEnv = process.env): void {
  const egress = config.autonomy?.boundary?.egress;
  if (!egress) {
    delete env[WORKER_PROXY_URL];
    delete env[WORKER_KEY_FILE];
    hostEgress = undefined;
    return;
  }
  env[WORKER_PROXY_URL] = egress.proxyUrl;
  env[WORKER_KEY_FILE] = egress.keyPath;
  hostEgress = { proxyUrl: egress.proxyUrl, keyPath: egress.keyPath, warned: false };
  void hostEgressEnvironment();
}

/**
 * Proxy variables for a host-run command, with a fresh host credential. Empty only when egress is not configured.
 * When the key cannot be read, the command still gets the proxy address, without a credential: its network requests
 * are refused with 407 rather than sent direct. That matters because a command run as the host account, which
 * happens without `teams.commandPrefix`, is outside the firewall rule, which matches only the agent account.
 * Local Git operations never use the proxy.
 */
export function hostEgressEnvironment(nowMs = Date.now()): Record<string, string> {
  if (!hostEgress) return {};
  if (!hostEgress.key) {
    try { hostEgress.key = readEgressKey(hostEgress.keyPath); }
    catch (error) {
      if (!hostEgress.warned) console.warn(`Egress: the host cannot read the egress key (${error instanceof EgressKeyError ? error.reason : "unavailable"}); the proxy refuses host commands' network requests until it can.`);
      hostEgress.warned = true;
      return egressUncredentialedEnvironment(hostEgress.proxyUrl);
    }
  }
  return egressProxyEnvironment(hostEgress.proxyUrl, hostEgress.key, HOST_IDENTITY, HOST_CREDENTIAL_SECONDS, nowMs);
}

/**
 * In a worker: the proxy variables for its session, from what the host process exported.
 * - `off`: egress is not configured. No variables; the environment is unchanged.
 * - `on`: the proxy address with the session's credential.
 * - `no-key`: the key cannot be read. The proxy address without a credential, so requests get 407 instead of going
 *   direct; the worker records the gap.
 * - `invalid`: the inherited proxy address is unusable. No session may start, since none could be routed.
 */
export function workerEgressEnvironment(projectId: string | undefined, sessionId: string, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now()):
  { status: "off" | "on" | "no-key" | "invalid"; env: Record<string, string> } {
  const proxyUrl = env[WORKER_PROXY_URL], keyPath = env[WORKER_KEY_FILE];
  if (proxyUrl === undefined && keyPath === undefined) return { status: "off", env: {} };
  if (!proxyUrl || !loopbackProxyUrl(proxyUrl)) return { status: "invalid", env: {} };
  const refused = { status: "no-key" as const, env: egressUncredentialedEnvironment(proxyUrl) };
  if (!keyPath || !isAbsolute(keyPath)) return refused;
  let key: Buffer;
  try { key = readEgressKey(keyPath); } catch { return refused; }
  return { status: "on", env: egressProxyEnvironment(proxyUrl, key, sessionEgressIdentity(projectId, sessionId), SESSION_CREDENTIAL_SECONDS, nowMs) };
}

// ---------------------------------------------------------------------------
// Summary, API view, CLI, doctor

const countsSchema = z.object({
  allowed: z.number().int().min(0).optional(),
  "would-deny": z.number().int().min(0).optional(),
  refused: z.number().int().min(0).optional(),
  unauthenticated: z.number().int().min(0).optional(),
}).strict();
const summarySchema = z.object({
  schema: z.literal(1),
  updatedAt: z.iso.datetime(),
  mode: z.enum(["observe", "enforce"]).nullable(),
  policy: z.object({ loadedAt: z.iso.datetime().nullable(), error: z.string().max(64).nullable() }).strict(),
  days: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.object({
    projects: z.record(z.string().regex(EGRESS_PROJECT), z.record(z.string().regex(/^(?:-|[a-z0-9._:[\]-]{1,260})$/), countsSchema)),
    dropped: countsSchema,
  }).strict()),
}).strict();
type EgressSummaryFile = z.infer<typeof summarySchema>;

export interface EgressCounts { allowed: number; wouldDeny: number; refused: number; unauthenticated: number }
export interface EgressHostView extends EgressCounts { host: string; total: number; lastDay: string }
export interface EgressView {
  configured: boolean;
  summary: "available" | "not-configured" | "missing" | "unreadable" | "invalid";
  mode: "observe" | "enforce" | null;
  updatedAt: string | null;
  ageSeconds: number | null;
  policyError: string | null;
  days: string[];
  dropped: EgressCounts;
  projects: { project: string; hosts: EgressHostView[] }[];
}

const zero = (): EgressCounts => ({ allowed: 0, wouldDeny: 0, refused: 0, unauthenticated: 0 });
function addCounts(target: EgressCounts, counts: z.infer<typeof countsSchema>) {
  target.allowed += counts.allowed ?? 0;
  target.wouldDeny += counts["would-deny"] ?? 0;
  target.refused += counts.refused ?? 0;
  target.unauthenticated += counts.unauthenticated ?? 0;
}

function readSummary(path: string): { summary?: EgressSummaryFile; state: EgressView["summary"] } {
  let info: ReturnType<typeof statSync>;
  try { info = statSync(path); } catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" }; }
  if (!info.isFile() || info.size > MAX_SUMMARY_BYTES) return { state: "invalid" };
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { state: "unreadable" }; }
  try {
    const parsed = summarySchema.safeParse(JSON.parse(text));
    return parsed.success ? { summary: parsed.data, state: "available" } : { state: "invalid" };
  } catch { return { state: "invalid" }; }
}

/** What the owner reads to build the allowlist: hosts per project over the retained days, would-deny first. */
export function egressView(config: Pick<Config, "autonomy">, project?: string, nowMs = Date.now()): EgressView {
  const egress = config.autonomy?.boundary?.egress;
  const empty: EgressView = { configured: Boolean(egress), summary: "not-configured", mode: null, updatedAt: null, ageSeconds: null, policyError: null, days: [], dropped: zero(), projects: [] };
  if (!egress?.summaryPath) return empty;
  const { summary, state } = readSummary(egress.summaryPath);
  if (!summary) return { ...empty, summary: state };
  const dropped = zero();
  const projects = new Map<string, Map<string, EgressHostView>>();
  const days = Object.keys(summary.days).sort();
  for (const day of days) {
    const entry = summary.days[day];
    addCounts(dropped, entry.dropped);
    for (const [name, hosts] of Object.entries(entry.projects)) {
      if (project !== undefined && name !== project) continue;
      let views = projects.get(name);
      if (!views) projects.set(name, views = new Map());
      for (const [host, counts] of Object.entries(hosts)) {
        let view = views.get(host);
        if (!view) views.set(host, view = { host, ...zero(), total: 0, lastDay: day });
        addCounts(view, counts);
        view.total = view.allowed + view.wouldDeny + view.refused + view.unauthenticated;
        view.lastDay = day;
      }
    }
  }
  const byConcern = (a: EgressHostView, b: EgressHostView) =>
    Number(b.wouldDeny > 0) - Number(a.wouldDeny > 0) || b.wouldDeny - a.wouldDeny || b.total - a.total || a.host.localeCompare(b.host);
  const list = [...projects].map(([name, hosts]) => ({ project: name, hosts: [...hosts.values()].sort(byConcern) }))
    .sort((a, b) => Number(b.hosts.some(host => host.wouldDeny > 0)) - Number(a.hosts.some(host => host.wouldDeny > 0)) || a.project.localeCompare(b.project));
  const updated = Date.parse(summary.updatedAt);
  return {
    configured: true, summary: "available", mode: summary.mode, updatedAt: summary.updatedAt,
    ageSeconds: Math.max(0, Math.round((nowMs - updated) / 1000)), policyError: summary.policy.error, days, dropped, projects: list,
  };
}

const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 300);
const age = (seconds: number) => seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.round(seconds / 60)}m` : seconds < 172800 ? `${Math.round(seconds / 3600)}h` : `${Math.round(seconds / 86400)}d`;

/** Lines for `infinite egress`. */
export function egressLines(view: EgressView): string[] {
  if (!view.configured) return ["Egress: not configured on this host."];
  if (view.summary !== "available") return [`Egress: configured · summary ${clean(view.summary)}`];
  const lines = [`Egress: ${clean(view.mode ?? "no valid policy")} · summary updated ${age(view.ageSeconds ?? 0)} ago · ${view.days.length} day${view.days.length === 1 ? "" : "s"}${view.days.length ? ` (${clean(view.days[0])} to ${clean(view.days.at(-1))})` : ""}`];
  if (view.policyError) lines.push(`Policy: the last reload failed (${clean(view.policyError)}); the previous policy stays in force.`);
  const dropped = view.dropped.allowed + view.dropped.wouldDeny + view.dropped.refused + view.dropped.unauthenticated;
  if (dropped > 0) lines.push(`Not itemized (daily host limit reached): ${dropped} connections, ${view.dropped.wouldDeny} would-deny.`);
  if (view.projects.length === 0) lines.push("No connections recorded.");
  for (const project of view.projects) {
    lines.push(clean(project.project));
    for (const host of project.hosts) {
      const counts = [["would-deny", host.wouldDeny], ["allowed", host.allowed], ["refused", host.refused], ["unauthenticated", host.unauthenticated]]
        .filter(([, count]) => (count as number) > 0).map(([name, count]) => `${name} ${count}`).join(" · ");
      lines.push(`  ${clean(host.host)}  ${counts} · last ${clean(host.lastDay)}`);
    }
  }
  return lines;
}

const EGRESS_USAGE = "Usage: infinite egress [--project ID] [--json]";
type EgressApi = { json<T = unknown>(path: string): Promise<T> };
/** `infinite egress [--project ID] [--json]`: the hosts agents reached, for building the allowlist from observe mode. */
export async function handleEgressClientCommand(positional: string[], options: Record<string, string | boolean>, api: EgressApi): Promise<boolean> {
  if (positional.length > 0) throw new Error(EGRESS_USAGE);
  const project = options["--project"];
  if (project !== undefined && (typeof project !== "string" || !EGRESS_PROJECT.test(project))) throw new Error(EGRESS_USAGE);
  const view = await api.json<EgressView>(`/egress${project ? `?project=${encodeURIComponent(project)}` : ""}`);
  if (options["--json"] === true) console.log(JSON.stringify(view, null, 2));
  else for (const line of egressLines(view)) console.log(line);
  return true;
}

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = (reachable: boolean) => { socket.destroy(); resolve(reachable); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** One `doctor` line: proxy reachable, key readable, summary age. */
export async function egressDoctorLine(egress: EgressConfig, nowMs = Date.now()): Promise<string> {
  const url = new URL(egress.proxyUrl);
  const reachable = await probe(url.hostname.replace(/^\[|\]$/g, ""), Number(url.port), 2000);
  let key = "key readable";
  try { readEgressKey(egress.keyPath); }
  catch (error) { key = `key UNREADABLE (${error instanceof EgressKeyError ? error.reason : "unavailable"}): new sessions and host commands get the proxy without a credential, so their network requests are refused with 407`; }
  let summary = "summary not configured";
  if (egress.summaryPath) {
    const view = egressView({ autonomy: { boundary: { egress } } }, undefined, nowMs);
    summary = view.summary === "available" ? `summary updated ${age(view.ageSeconds ?? 0)} ago (${view.mode ?? "no valid policy"})` : `summary ${view.summary}`;
  }
  return `Egress: proxy ${reachable ? "reachable" : "UNREACHABLE"} at ${url.host} · ${key} · ${summary}`;
}
