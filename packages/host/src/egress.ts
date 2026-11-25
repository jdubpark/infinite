import { createHmac } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { learningPurpose, type Config, type SessionPurpose } from "./types.js";

const CREDENTIAL_CONTEXT = "infinite-egress/v1";
export const SESSION_CREDENTIAL_SECONDS = 30 * 24 * 60 * 60;
export const HOST_CREDENTIAL_SECONDS = 24 * 60 * 60;
export const HOST_IDENTITY = { project: "_host", session: "host" } as const;
export const EVAL_EGRESS_PROJECT = "_eval", EVAL_SETUP_EGRESS_PROJECT = "_eval-setup",
  EVAL_SETUP_CREDENTIAL_SECONDS = 900, EVAL_PROBE_CREDENTIAL_SECONDS = 60;
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
const PROJECT_LABEL = /^(?:_host|_none|_eval-setup|_eval|[a-z0-9-]{1,80})$/;
const SESSION_LABEL = /^[A-Za-z0-9-]{1,64}$/;
export const EGRESS_PROJECT = /^(?:_unauthenticated|_host|_none|_eval-setup|_eval|[a-z0-9-]{1,80})$/;
const KEY_BYTES = 32;
const MAX_SUMMARY_BYTES = 16 * 1024 * 1024;
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

export function clearEgressEnvironment(env: Record<string, string | undefined>): void {
  for (const name of EGRESS_ENVIRONMENT_NAMES) delete env[name];
}

export function egressProxyEnvironment(proxyUrl: string, key: Buffer, identity: EgressIdentity, lifetimeSeconds: number, nowMs = Date.now()): Record<string, string> {
  const { username, password } = egressCredential(key, identity.project, identity.session, Math.floor(nowMs / 1000) + lifetimeSeconds);
  const value = `http://${username}:${password}@${new URL(proxyUrl).host}`;
  return proxyEnvironment(value);
}

export function egressUncredentialedEnvironment(proxyUrl: string): Record<string, string> {
  const value = `http://${new URL(proxyUrl).host}`;
  return proxyEnvironment(value);
}

export function sessionEgressIdentity(projectId: string | undefined, sessionId: string, purpose?: SessionPurpose): EgressIdentity {
  if (learningPurpose(purpose)) return { project: EVAL_EGRESS_PROJECT, session: sessionId };
  return { project: projectId && PROJECT_ID.test(projectId) ? projectId : "_none", session: sessionId };
}

let hostEgress: { proxyUrl: string; keyPath: string; key?: Buffer; warned: boolean } | undefined;

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

export function agentModelClientEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  clearEgressEnvironment(env);
  Object.assign(env, hostEgressEnvironment());
  return env;
}

export function workerEgressEnvironment(projectId: string | undefined, sessionId: string, env: NodeJS.ProcessEnv = process.env, nowMs = Date.now(), purpose?: SessionPurpose):
  { status: "off" | "on" | "no-key" | "invalid"; env: Record<string, string> } {
  const proxyUrl = env[WORKER_PROXY_URL], keyPath = env[WORKER_KEY_FILE];
  if (proxyUrl === undefined && keyPath === undefined) return { status: "off", env: {} };
  if (!proxyUrl || !loopbackProxyUrl(proxyUrl)) return { status: "invalid", env: {} };
  const refused = { status: "no-key" as const, env: egressUncredentialedEnvironment(proxyUrl) };
  if (!keyPath || !isAbsolute(keyPath)) return refused;
  let key: Buffer;
  try { key = readEgressKey(keyPath); } catch { return refused; }
  return { status: "on", env: egressProxyEnvironment(proxyUrl, key, sessionEgressIdentity(projectId, sessionId, purpose), SESSION_CREDENTIAL_SECONDS, nowMs) };
}

export function evalProxyUrl(project: "_eval" | "_eval-setup", session: string, lifetimeSeconds: number, nowMs = Date.now()): string | undefined {
  if (!hostEgress) return undefined;
  const address = new URL(hostEgress.proxyUrl).host;
  if (!hostEgress.key) {
    try { hostEgress.key = readEgressKey(hostEgress.keyPath); }
    catch { return `http://${address}`; }
  }
  const { username, password } = egressCredential(hostEgress.key, project, session, Math.floor(nowMs / 1000) + lifetimeSeconds);
  return `http://${username}:${password}@${address}`;
}

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
