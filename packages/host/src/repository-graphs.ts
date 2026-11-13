import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "./types.js";
import type { TeamCommand } from "./team-types.js";
import { teamCommand, teamGitArgs } from "./team-workspace.js";
import { z } from "zod";

export type RepositoryCodeMap = { areas: { id: string; files: number; symbols: number }[]; links: { source: string; target: string; weight: number }[]; truncated: { areas: boolean; links: boolean } };
export type RepositoryGraphResult = {
  status: "ready" | "unchanged" | "failed" | "busy";
  graphPath?: string;
  head?: string;
  requestedHead: string;
  mode?: "initial" | "incremental" | "unchanged";
  changedFiles?: number;
  deletedFiles?: number;
  reason?: string;
  warnings?: string[];
  map?: RepositoryCodeMap;
  mapStatus?: "too-large";
};
export type CodeMapView = ({ state: "ready"; lane: string; head: string; builtAt: string } & RepositoryCodeMap) | { state: "disabled" } | { state: "unavailable"; reason: "none-built" | "too-large" };

// The builder output crosses a process boundary, so the map is untrusted until it parses here.
const codeMapId = z.string().min(1).max(300).refine(value => !value.startsWith("/") && !value.includes("\0") && !value.includes("\\") && !value.split("/").includes(".."));
const codeMapCount = z.number().int().nonnegative();
const repositoryCodeMapSchema = z.strictObject({
  areas: z.array(z.strictObject({ id: codeMapId, files: codeMapCount, symbols: codeMapCount })).max(120),
  links: z.array(z.strictObject({ source: codeMapId, target: codeMapId, weight: codeMapCount })).max(400),
  truncated: z.strictObject({ areas: z.boolean(), links: z.boolean() }),
});
/** The builder enforces this too; the host does not take its word for it. */
const MAX_CODE_MAP_BYTES = 262_144;
const parseCodeMap = (value: unknown): RepositoryCodeMap | "too-large" | undefined => {
  const parsed = repositoryCodeMapSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_CODE_MAP_BYTES ? "too-large" : parsed.data;
};
const withoutCodeMap = (result: RepositoryGraphResult): RepositoryGraphResult => {
  const copy = { ...result };
  delete copy.map;
  delete copy.mapStatus;
  return copy;
};
type GraphConfig = NonNullable<Config["repositoryGraphs"]>;
type Waiter = { head: string; resolve: (result: RepositoryGraphResult) => void; signal?: AbortSignal; abort?: () => void; settled?: boolean };
type Lane = { key: string; projectId: string; ownerRoot: string; laneAuthority: string; root: string; cacheDir: string; seedCacheDir: string; lane: string; desiredHead: string; buildingHead?: string; running: boolean; timer?: ReturnType<typeof setTimeout>; waiters: Waiter[] };
type Receipt = { projectId: string; lane: string; ownerRoot: string; laneAuthority: string; root: string; result: RepositoryGraphResult; at: string };
const MAX_RECEIPTS = 128;
const MAX_LANES = 128;
const MAX_PENDING = 256;
const MAX_LANE_WAITERS = 64;
const MAX_OUTPUT = 1024 * 1024;
const isHead = (value: string) => /^[a-f0-9]{40,64}$/i.test(value);
const safeLane = (value: string) => /^[a-z0-9-]{1,80}$/.test(value);

/** Advisory, code-only Graphify queue. It never fetches source or gates an agent launch. */
export class RepositoryGraphs {
  private readonly lanes = new Map<string, Lane>();
  private readonly activeProjects = new Set<string>();
  private readonly children = new Set<ChildProcess>();
  private readonly probes = new Set<AbortController>();
  private readonly receipts = new Map<string, Receipt>();
  /** The last receipt per lane that carried a code map or its too-large marker. */
  private readonly maps = new Map<string, Receipt>();
  private readonly pendingProjects = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private active = 0;
  private waiting = 0;

  constructor(private readonly config: GraphConfig, private readonly projects: Config["projects"], private readonly workspaceRoot?: string, private readonly gitPrefix?: TeamCommand, private readonly maxGlobal = 2) {}

  private identity(projectId: string, root: string, laneAuthority: string, lane: string) {
    return `${projectId}\0${root}\0${laneAuthority}\0${lane}`;
  }

  /** Schedule an exact checkout head in a lane scoped to one configured project root. */
  refresh(projectId: string, repoPath: string, head: string, lane = "shared", signal?: AbortSignal): Promise<RepositoryGraphResult> {
    if (this.closed) return Promise.resolve({ status: "failed", requestedHead: head, reason: "Repository graph service is closed." });
    if (signal?.aborted) return Promise.resolve({ status: "failed", requestedHead: head, reason: "Graph checkpoint wait was cancelled." });
    if (!isHead(head) || !safeLane(lane)) return Promise.resolve({ status: "failed", requestedHead: head, reason: "Invalid graph checkpoint." });
    const project = this.projects.find(item => item.id === projectId);
    if (!project) return Promise.resolve({ status: "failed", requestedHead: head, reason: "Project is not configured." });
    if (this.config.projectIds && !this.config.projectIds.includes(projectId))
      return Promise.resolve({ status: "failed", requestedHead: head, reason: "Project is outside the configured graph refresh filter." });
    let root: string, ownerRoot: string, laneAuthority: string;
    try {
      root = realpathSync(repoPath);
      ownerRoot = realpathSync(project.path);
      const workspaceRoot = project.teamworkDir ?? this.workspaceRoot;
      // A team checkout may be below its configured workspace root; shared refreshes must be exact.
      if (lane === "shared" && root !== ownerRoot)
        return Promise.resolve({ status: "failed", requestedHead: head, reason: "Shared graph path does not match the configured project root." });
      if (lane !== "shared" && (!workspaceRoot || !this.inside(realpathSync(workspaceRoot), root)))
        return Promise.resolve({ status: "failed", requestedHead: head, reason: "Feature graph path is outside the configured team workspace." });
      laneAuthority = lane === "shared" ? ownerRoot : realpathSync(workspaceRoot!);
    } catch {
      return Promise.resolve({ status: "failed", requestedHead: head, reason: "Configured graph source path is unavailable." });
    }
    const key = this.identity(projectId, ownerRoot, laneAuthority, lane);
    let state = this.lanes.get(key);
    if (!state) {
      this.pruneLanes();
      if (this.lanes.size >= MAX_LANES) return Promise.resolve({ status: "busy", requestedHead: head, reason: "Graph refresh queue is full." });
      const owner = createHash("sha256").update(`${projectId}\0${ownerRoot}\0${laneAuthority}`).digest("hex").slice(0, 24);
      const sharedOwner = createHash("sha256").update(`${projectId}\0${ownerRoot}\0${ownerRoot}`).digest("hex").slice(0, 24);
      state = { key, projectId, ownerRoot, laneAuthority, root, lane, desiredHead: head, running: false, waiters: [],
        cacheDir: join(this.config.cacheDir, owner, lane), seedCacheDir: join(this.config.cacheDir, sharedOwner, "shared") };
      this.lanes.set(key, state);
    }
    if (!state.running && state.desiredHead === head) {
      const receipt = this.receipts.get(key);
      if ((receipt?.result.status === "ready" || receipt?.result.status === "unchanged") && receipt.result.head === head)
        return Promise.resolve({ ...receipt.result, status: "unchanged", mode: "unchanged", requestedHead: head });
    }
    const preserve = state.running ? new Set([state.buildingHead, head]) : new Set([head]);
    if (state.desiredHead !== head && state.waiters.length) this.supersede(state, preserve);
    if (this.waiting >= MAX_PENDING || state.waiters.length >= MAX_LANE_WAITERS)
      return Promise.resolve({ status: "busy", requestedHead: head, reason: "Graph refresh queue is full." });
    state.root = root;
    state.desiredHead = head;
    return new Promise(resolve => {
      const waiter: Waiter = { head, resolve, signal };
      waiter.abort = () => {
        const index = state!.waiters.indexOf(waiter);
        if (index >= 0) { state!.waiters.splice(index, 1); this.waiting--; }
        this.settle(waiter, { status: "failed", requestedHead: head, reason: "Graph checkpoint wait was cancelled." });
        if (!state!.running && !state!.waiters.length && state!.timer) { clearTimeout(state!.timer); state!.timer = undefined; }
        this.pruneLanes();
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      state!.waiters.push(waiter); this.waiting++;
      this.schedule(state!);
    });
  }

  private settle(waiter: Waiter, result: RepositoryGraphResult) {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    waiter.resolve(result);
  }

  private pruneLanes() {
    for (const [key, lane] of this.lanes) {
      if (this.lanes.size < MAX_LANES) break;
      if (!lane.running && !lane.timer && !lane.waiters.length) this.lanes.delete(key);
    }
  }

  private supersede(lane: Lane, preserve: Set<string | undefined>) {
    const retained: Waiter[] = [];
    for (const waiter of lane.waiters) {
      if (preserve.has(waiter.head)) retained.push(waiter);
      else { this.waiting--; this.settle(waiter, { status: "failed", requestedHead: waiter.head, reason: "Graph checkpoint was superseded by a newer exact head." }); }
    }
    lane.waiters = retained;
  }

  private inside(root: string, candidate: string) {
    const child = relative(root, candidate);
    return child === "" || child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  }

  private schedule(lane: Lane, delay = this.config.debounceMs) {
    if (lane.timer) clearTimeout(lane.timer);
    lane.timer = setTimeout(() => { lane.timer = undefined; this.pump(); }, delay);
  }

  private pump() {
    if (this.closed) return;
    for (const lane of this.lanes.values()) {
      if (this.active >= this.maxGlobal) break;
      if (lane.running || lane.timer || !lane.waiters.length || this.activeProjects.has(lane.projectId)) continue;
      this.active++; this.activeProjects.add(lane.projectId); lane.running = true; lane.buildingHead = lane.desiredHead;
      void this.build(lane).finally(() => {
        lane.running = false; lane.buildingHead = undefined; this.active--; this.activeProjects.delete(lane.projectId);
        if (lane.waiters.length && !lane.timer) this.schedule(lane, 0);
        this.pump();
      });
    }
  }

  private async build(lane: Lane) {
    const head = lane.desiredHead, root = lane.root;
    if (!this.currentAuthority(lane, root)) {
      const failure = { status: "failed" as const, requestedHead: head, reason: "Project or checkout authority changed before graph refresh." };
      this.record(lane, root, failure);
      this.resolve(lane, head, failure);
      return;
    }
    const args = [...this.config.args, "--repo", root, "--cache-dir", lane.cacheDir,
      ...(lane.lane === "shared" ? [] : ["--seed-cache-dir", lane.seedCacheDir]), "--ref", head,
      "--graphify", this.config.graphifyCommand, "--timeout-seconds", String(Math.max(1, Math.floor(this.config.timeoutMs / 1000))), "--max-workers", "2"];
    const result = await this.run(this.config.command, args);
    let parsed: RepositoryGraphResult;
    try {
      if (result.error) throw new Error(result.error);
      const data = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "") as Partial<RepositoryGraphResult>;
      const codeMap = parseCodeMap(data.map);
      const valid = ["ready", "unchanged", "failed", "busy"].includes(data.status ?? "") && data.requestedHead === head;
      parsed = valid ? { status: data.status!, requestedHead: head, ...(data.graphPath && isAbsolute(data.graphPath) ? { graphPath: data.graphPath } : {}),
        ...(data.head && isHead(data.head) ? { head: data.head } : {}), ...(data.mode && ["initial", "incremental", "unchanged"].includes(data.mode) ? { mode: data.mode } : {}),
        ...(Number.isInteger(data.changedFiles) && data.changedFiles! >= 0 ? { changedFiles: data.changedFiles } : {}), ...(Number.isInteger(data.deletedFiles) && data.deletedFiles! >= 0 ? { deletedFiles: data.deletedFiles } : {}),
        ...(typeof data.reason === "string" ? { reason: data.reason.slice(0, 400) } : {}), ...(Array.isArray(data.warnings) ? { warnings: data.warnings.filter((v): v is string => typeof v === "string").slice(0, 8).map(v => v.slice(0, 300)) } : {}),
          ...(codeMap && codeMap !== "too-large" ? { map: codeMap } : {}), ...(data.mapStatus === "too-large" || codeMap === "too-large" ? { mapStatus: "too-large" as const } : {}) }
        : { status: "failed", requestedHead: head, reason: result.error ?? "Graph builder returned an invalid receipt." };
      if (!["ready", "unchanged"].includes(parsed.status) || parsed.head !== head || !parsed.graphPath || !this.graphPathInLane(lane, parsed.graphPath))
        parsed = { ...parsed, status: parsed.status === "busy" ? "busy" : "failed", reason: parsed.reason ?? result.error ?? "No successful graph for the requested checkout head." };
      if (!["ready", "unchanged"].includes(parsed.status)) parsed = withoutCodeMap(parsed);
      if (!this.currentAuthority(lane, root)) parsed = { status: "failed", requestedHead: head, reason: "Project or checkout authority changed during graph refresh." };
    } catch {
      parsed = { status: "failed", requestedHead: head, reason: result.error ?? "Graph builder returned no valid receipt." };
    }
    this.record(lane, root, parsed);
    this.resolve(lane, head, parsed);
  }

  private resolve(lane: Lane, head: string, parsed: RepositoryGraphResult) {
    // Resolve only waiters for the head actually built. A newer request keeps its own waiter and run.
    const completed = lane.waiters.filter(item => item.head === head);
    lane.waiters = lane.waiters.filter(item => item.head !== head);
    for (const waiter of completed) { this.waiting--; this.settle(waiter, parsed); }
  }

  private currentAuthority(lane: Lane, root: string) {
    try {
      const project = this.projects.find(item => item.id === lane.projectId);
      if (!project || this.config.projectIds && !this.config.projectIds.includes(lane.projectId) ||
          realpathSync(project.path) !== lane.ownerRoot || realpathSync(root) !== root) return false;
      return lane.lane === "shared" ? root === lane.ownerRoot
        : Boolean((project.teamworkDir ?? this.workspaceRoot) &&
          realpathSync(project.teamworkDir ?? this.workspaceRoot!) === lane.laneAuthority && this.inside(lane.laneAuthority, root));
    } catch { return false; }
  }

  private graphPathInLane(lane: Lane, graphPath: string) {
    if (!isAbsolute(graphPath)) return false;
    const cache = resolve(lane.cacheDir), artifact = resolve(graphPath);
    return this.inside(cache, artifact);
  }

  private run(command: string, args: string[]) {
    return new Promise<{ stdout: string; error?: string }>(resolve => {
      if (this.closed) return resolve({ stdout: "", error: "Repository graph service is closed." });
      let stdout = "", failed = "", settled = false;
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" } });
      this.children.add(child);
      const finish = (error?: string) => { if (settled) return; settled = true; clearTimeout(timeout); this.children.delete(child); resolve({ stdout, ...(error ? { error } : {}) }); };
      const timeout = setTimeout(() => { kill(child); finish("Graph refresh timed out."); }, this.config.timeoutMs);
      // Decode as a stream: a multi-byte character split across two chunks must not turn into replacement characters.
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (settled) return;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > MAX_OUTPUT) { kill(child); finish("Graph builder output exceeded the limit."); return; }
        stdout += chunk;
      });
      child.stderr?.on("data", chunk => { failed += chunk.toString(); if (Buffer.byteLength(failed) > MAX_OUTPUT) failed = failed.slice(-MAX_OUTPUT); });
      child.once("error", error => finish(error.message.slice(0, 300)));
      child.once("close", code => finish(code === 0 ? undefined : failed.trim().slice(-400) || `Graph builder exited with code ${code}.`));
    });
  }

  private record(lane: Lane, root: string, result: RepositoryGraphResult) {
    const receipt = { projectId: lane.projectId, lane: lane.lane, ownerRoot: lane.ownerRoot, laneAuthority: lane.laneAuthority, root, result, at: new Date().toISOString() };
    this.receipts.delete(lane.key); this.receipts.set(lane.key, receipt);
    while (this.receipts.size > MAX_RECEIPTS) this.receipts.delete(this.receipts.keys().next().value!);
    // A lane keeps its last good map through a later failed or busy refresh.
    if (["ready", "unchanged"].includes(result.status) && (result.map || result.mapStatus === "too-large")) {
      this.maps.delete(lane.key); this.maps.set(lane.key, receipt);
      while (this.maps.size > MAX_RECEIPTS) this.maps.delete(this.maps.keys().next().value!);
    }
  }

  private authorized(item: Receipt) {
    if (this.config.projectIds && !this.config.projectIds.includes(item.projectId)) return false;
    try {
      const project = this.projects.find(candidate => candidate.id === item.projectId);
      if (!project || realpathSync(project.path) !== item.ownerRoot) return false;
      return item.lane === "shared" || realpathSync(project.teamworkDir ?? this.workspaceRoot ?? "") === item.laneAuthority;
    }
    catch { return false; }
  }

  /** Current bounded status receipts, without exposing configured source roots or code maps. */
  status(projectId?: string) {
    return [...this.receipts.values()].filter(item => (!projectId || item.projectId === projectId) && this.authorized(item))
      .map(({ projectId: id, lane, result, at }) => {
        const copy = structuredClone(result);
        delete copy.map;
        return { projectId: id, lane, result: copy, at };
      });
  }

  /** The newest authorized receipt of one lane that carried a map, or one whose map was too large. */
  private mapReceipt(projectId: string, lane: string): Receipt | undefined {
    let newest: Receipt | undefined;
    for (const item of this.maps.values()) {
      if (item.projectId !== projectId || item.lane !== lane) continue;
      if (!this.authorized(item)) continue;
      if (!newest || item.at > newest.at) newest = item;
    }
    return newest;
  }

  /** Directory-level code map for one lane, falling back to the shared lane when the lane has none. */
  codeMap(projectId: string, lane = "shared"): CodeMapView {
    if (!this.projects.some(item => item.id === projectId) || this.config.projectIds && !this.config.projectIds.includes(projectId))
      return { state: "disabled" };
    const receipt = this.mapReceipt(projectId, lane) ?? (lane === "shared" ? undefined : this.mapReceipt(projectId, "shared"));
    if (!receipt) return { state: "unavailable", reason: "none-built" };
    const { map, head } = receipt.result;
    if (!map) return { state: "unavailable", reason: "too-large" };
    if (!head) return { state: "unavailable", reason: "none-built" };
    return {
      state: "ready", lane: receipt.lane, head, builtAt: receipt.at,
      areas: map.areas.map(area => ({ ...area })), links: map.links.map(link => ({ ...link })), truncated: { ...map.truncated },
    };
  }

  /** Shared-lane area IDs, used to decide which directories an agent's tool inputs may name. */
  areas(projectId: string): ReadonlySet<string> | undefined {
    const view = this.codeMap(projectId, "shared");
    return view.state === "ready" ? new Set(view.areas.map(area => area.id)) : undefined;
  }

  start() {
    if (this.timer || this.closed) return;
    const refreshEnrolled = () => {
      for (const project of this.projects) if ((project.team || project.source?.mode === "github") &&
          (!this.config.projectIds || this.config.projectIds.includes(project.id))) {
        if (this.pendingProjects.has(project.id)) continue;
        this.pendingProjects.add(project.id);
        void this.refreshCurrent(project.id, project.path, "shared").finally(() => this.pendingProjects.delete(project.id));
      }
    };
    refreshEnrolled();
    this.timer = setInterval(refreshEnrolled, this.config.intervalMs);
    this.timer.unref?.();
  }

  async refreshCurrent(projectId: string, root: string, lane = "shared", signal?: AbortSignal) {
    if (this.closed) return { status: "failed" as const, requestedHead: "", reason: "Repository graph service is closed." };
    if (signal?.aborted) return { status: "failed" as const, requestedHead: "", reason: "Graph checkpoint wait was cancelled." };
    if (this.config.projectIds && !this.config.projectIds.includes(projectId))
      return { status: "failed" as const, requestedHead: "", reason: "Project is outside the configured graph refresh filter." };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    this.probes.add(controller);
    let probe;
    try { probe = await teamCommand({ command: "git", args: teamGitArgs(root, ["rev-parse", "HEAD"]) }, root, controller.signal, 10_000, this.gitPrefix); }
    catch {
      probe = undefined;
    } finally { signal?.removeEventListener("abort", cancel); this.probes.delete(controller); }
    const head = probe?.exitCode === 0 && !probe.interrupted ? probe.stdout.trim() : "";
    if (isHead(head)) return this.refresh(projectId, root, head, lane, signal);
    const reason = probe?.interrupted ? "Current project head check timed out." : "Current project head could not be confirmed.";
    const project = this.projects.find(item => item.id === projectId);
    if (project) try {
        const ownerRoot = realpathSync(project.path), actualRoot = realpathSync(root), laneAuthority = lane === "shared" ? ownerRoot : realpathSync(project.teamworkDir ?? this.workspaceRoot ?? "");
        const key = this.identity(projectId, ownerRoot, laneAuthority, lane);
        const owner = createHash("sha256").update(`${projectId}\0${ownerRoot}\0${laneAuthority}`).digest("hex").slice(0, 24);
        const sharedOwner = createHash("sha256").update(`${projectId}\0${ownerRoot}\0${ownerRoot}`).digest("hex").slice(0, 24);
        const state = this.lanes.get(key) ?? { key, projectId, ownerRoot, laneAuthority, root: actualRoot, lane, desiredHead: "", running: false, waiters: [], cacheDir: join(this.config.cacheDir, owner, lane), seedCacheDir: join(this.config.cacheDir, sharedOwner, "shared") };
      this.lanes.set(key, state);
      const failure = { status: "failed" as const, requestedHead: "", reason };
      this.record(state, actualRoot, failure);
      return failure;
    } catch { /* Return the failure even if the source path disappeared. */ }
    return { status: "failed" as const, requestedHead: "", reason };
  }

  close() {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    for (const lane of this.lanes.values()) {
      if (lane.timer) clearTimeout(lane.timer); lane.timer = undefined;
      for (const waiter of lane.waiters.splice(0)) { this.waiting--; this.settle(waiter, { status: "failed", requestedHead: waiter.head, reason: "Repository graph service closed before refresh completed." }); }
    }
    for (const probe of this.probes) probe.abort();
    for (const child of this.children) kill(child);
  }
}

function kill(child: ChildProcess) {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { /* The process already exited. */ }
}
