# Cloud-default execution and workspace sync — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every provider launched through Infinite runs on the cloud machine by default, and a detached laptop service keeps the configured cloud project directory current with the owner's Mac checkout, one way, with explicit apply while sessions run.

**Architecture:** The CLI stops defaulting Codex to laptop execution; `--laptop` becomes the explicit opt-in that keeps today's hybrid handoff. Session records gain `executionLocation`. A new host module `project-sync.ts` stores received manifests and blobs per project under the state directory, applies a received generation to the configured project path by sibling stage-and-rename, and refuses to apply while a cloud session runs in that project or when the cloud tree has drifted from the last applied generation. A new detached laptop process `sync-service.ts` reuses `captureWorkspace` and pushes blobs and manifests over the owner's direct HTTPS API.

**Tech Stack:** TypeScript on Node.js 22, Express, zod, `node:test` via `tsx`, existing `workspace-checkpoint.ts` capture and materialize primitives, React web client, Expo mobile client.

**Spec:** `docs/superpowers/specs/2026-10-16-cloud-first-execution-design.md` (sections "Execution model", "Workspace sync", "Scope boundary", "API summary", "Documentation changes").

## Global Constraints

- Node.js 22.14+ and npm. Run `npm run check` (typecheck, tests, builds) before declaring host work complete. For mobile changes also run `npm run lint -w @infinite/mobile` and `npx tsc --noEmit` in `apps/mobile`.
- Never write home-directory paths, hostnames, IPs, or secrets into tracked files. Tests use `mkdtempSync("/tmp/inf-...")` as the existing suites do.
- The host never infers task completion and never approves a provider permission on its own (`PRODUCT.md`).
- Sync scope rules from `docs/hybrid-execution.md` stay: Git decides the project root, the home directory and filesystem root are refused, the whole scope travels including ignored and untracked files.
- Only sessions started through Infinite are affected. The sync service watches only configured Infinite projects, only while running. Nothing in this plan touches provider configuration, shell startup files, or global hooks.
- Sync is laptop to cloud only. The cloud workspace is the executing copy.
- Commit messages: no `Claude-Session:` trailers.

## Scope decisions recorded here

- **One root per project sync.** `infinite sync` syncs the Git root (or the current directory outside Git) to the configured project path. `--include` is refused for `infinite sync` with a message pointing at `--laptop`. Reason: the project path is one directory; multi-root mapping has no home in the cloud layout. The spec's "Scope rules are unchanged" line is amended by Task 11.
- **Pull is project-level.** `infinite pull PROJECT_ID [--output DIR]` downloads the current cloud project tree. The session-based `infinite recover` stays for `--laptop` sessions. The spec's "recovery download" line is amended by Task 11.
- **Auto-apply when safe.** A received generation is applied automatically when no cloud session runs in that project and the cloud tree equals the last applied generation. Otherwise it stays pending with a reason. This satisfies "without the owner copying anything by hand" while keeping "explicit while a session runs".

## Review Focus

1. **Apply while a session runs must not touch files.** A manifest arriving while a demo session is running in the project must leave the project directory byte-identical and report `pendingGeneration.reason = "session-running"`. Test in Task 4.
2. **Apply onto a drifted cloud tree must refuse without `force`.** A file edited on the host after the last apply makes the next apply return 409 `cloud-changed`; `force: true` applies and the previous tree is kept at the sibling `.NAME.infinite-previous`. Test in Task 3.
3. **First apply onto a non-empty configured directory must refuse without `force`.** A configured project path that already holds files and has no applied manifest is treated as drifted. Test in Task 3.
4. **Stage and project path on different filesystems.** The stage directory is a sibling of the project path so the final `rename` never crosses filesystems. Test in Task 3 asserts the stage is created under `dirname(project.path)`.
5. **`--cloud` scripts keep working, `--laptop` without Codex fails clearly.** `infinite --cloud codex` is accepted as a no-op; `infinite --laptop claude` errors; `infinite --include ../x codex` without `--laptop` errors. Test in Task 1.

---

### Task 1: Flip the CLI default and record execution location

**Files:**
- Modify: `packages/host/src/types.ts:46-66` (Session), `:46` (SessionRuntime stays)
- Modify: `packages/host/src/manager.ts:300-320` (session construction in `createOnce`)
- Modify: `packages/host/src/server.ts:230-250` (`/api/me` `execution`)
- Modify: `packages/host/src/client.ts:323-346` (option parsing inside `handleClientCommand`)
- Modify: `packages/host/src/client-entry.ts:8-30` (help text)
- Modify: `apps/web/src/api.ts:6-30` (Session type), `apps/mobile/src/api/client.ts:122-150` (SessionRow)
- Test: `tests/client-args.test.ts` (new), `tests/cloud-default.test.ts` (new)

**Interfaces:**
- Produces: `Session.executionLocation: "cloud" | "laptop"` on every new session record and in list rows. `GET /api/me` → `execution: { laptop: boolean; cloudHandoff: boolean; default: "cloud" }`. Exported `parseClientArgs(argv: string[]): ParsedClientArgs` from `packages/host/src/client.ts` where

```ts
export interface ParsedClientArgs {
  command: string;
  args: string[];           // native provider args, or remaining positionals for non-provider commands
  options: Record<string, string | boolean>;
  includes: string[];
}
```

- [ ] **Step 1: Write the failing parse tests**

Create `tests/client-args.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseClientArgs } from "../packages/host/src/client.js";

test("codex defaults to cloud execution; --laptop is the explicit opt-in", () => {
  const cloud = parseClientArgs(["codex", "--model", "m", "Inspect"]);
  assert.equal(cloud.command, "codex");
  assert.equal(cloud.options["--laptop"], undefined);
  assert.equal(cloud.options["--local-ui"], undefined);
  assert.deepEqual(cloud.args, ["--model", "m", "Inspect"]);
  const laptop = parseClientArgs(["--laptop", "codex", "Inspect"]);
  assert.equal(laptop.options["--laptop"], true);
  assert.equal(laptop.options["--local-ui"], true, "laptop execution still requires the Codex native interface");
});

test("--cloud stays accepted as a no-op and conflicts with --laptop", () => {
  const parsed = parseClientArgs(["--cloud", "codex"]);
  assert.equal(parsed.options["--cloud"], true);
  assert.equal(parsed.options["--laptop"], undefined);
  assert.throws(() => parseClientArgs(["--cloud", "--laptop", "codex"]), /either cloud execution or --laptop/);
});

test("--laptop is Codex-only and --include needs --laptop", () => {
  assert.throws(() => parseClientArgs(["--laptop", "claude"]), /--laptop starts a Codex session/);
  assert.throws(() => parseClientArgs(["--include", "../shared", "codex"]), /--include applies to --laptop/);
  assert.deepEqual(parseClientArgs(["--include", "../shared", "--laptop", "codex"]).includes, ["../shared"]);
});

test("non-provider commands keep positionals and later options", () => {
  const parsed = parseClientArgs(["resume", "5ba58d55", "--takeover"]);
  assert.equal(parsed.command, "resume");
  assert.deepEqual(parsed.args, ["5ba58d55"]);
  assert.equal(parsed.options["--takeover"], true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/client-args.test.ts`
Expected: FAIL with `parseClientArgs is not a function` (or not exported).

- [ ] **Step 3: Extract `parseClientArgs` from `handleClientCommand` and flip the default**

In `packages/host/src/client.ts`, replace the block from `const args = [...argv];` through the `const positional: string[] = [];` loop (currently inside `handleClientCommand`) with a call to this new exported function placed above `handleClientCommand`:

```ts
const CLIENT_COMMANDS = new Set(["pair", "resume", "monitor", "recover", "projects", "list"]);
export interface ParsedClientArgs { command: string; args: string[]; options: Record<string, string | boolean>; includes: string[] }

/** Infinite options come before the provider; everything after a provider is passed through unchanged. */
export function parseClientArgs(argv: string[]): ParsedClientArgs {
  const args = [...argv];
  const options: Record<string, string | boolean> = {};
  const includes: string[] = [];
  const strings = new Set(["--client-config", "--project", "--title", "--token-file", "--output"]);
  const booleans = new Set(["--detach", "--json", "--local-ui", "--takeover", "--laptop", "--cloud"]);
  const option = () => {
    const name = args.shift()!;
    if (name === "--include" && args.length) includes.push(args.shift()!);
    else if (booleans.has(name)) options[name] = true;
    else if (strings.has(name) && args.length) options[name] = args.shift()!;
    else throw new Error(`Unknown or incomplete Infinite option: ${name}`);
  };
  while (args[0]?.startsWith("--")) option();
  const command = args.shift() ?? "";
  if (options["--cloud"] && options["--laptop"]) throw new Error("Choose either cloud execution or --laptop");
  if (options["--laptop"]) {
    if (command !== "codex") throw new Error("--laptop starts a Codex session in this directory. Resume existing sessions with infinite resume ID.");
    options["--local-ui"] = true;
  }
  if (includes.length && !options["--laptop"]) throw new Error("--include applies to --laptop execution; cloud sessions use the configured project");
  const positional: string[] = [];
  if (!providers.has(command)) while (args.length) { if (args[0].startsWith("--")) option(); else positional.push(args.shift()!); }
  return { command, args: providers.has(command) ? args : positional, options, includes };
}
```

Then in `handleClientCommand`, keep the early `candidate` check as is, and inside the `try` replace the parsing lines with:

```ts
    const parsed = parseClientArgs(args);
    const { command, options, includes } = parsed;
    if (!providers.has(command) && !CLIENT_COMMANDS.has(command)) return false;
    const positional = providers.has(command) ? [] : parsed.args;
    const nativeArgs = providers.has(command) ? parsed.args : [];
```

and replace every later use of `args` as the provider argument array with `nativeArgs` (the `validateNativeCodexArgs(args, ...)`, `validateNativeOpenCodeArgs(args)`, and `nativeArgs: args` in the create body). Remove the old line `if (command === "codex" && !options["--cloud"]) options["--laptop"] = true;`.

- [ ] **Step 4: Run the parse tests**

Run: `npx tsx --test tests/client-args.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add `executionLocation` to the session record and `/api/me`**

In `packages/host/src/types.ts`, add to `Session` after `machineId?: string;`:

```ts
  /** Where this session's tools run. Laptop execution is the explicit --laptop mode. */
  executionLocation?: "cloud" | "laptop";
```

In `packages/host/src/manager.ts` `createOnce`, add inside the `session: Session = {` literal after `machineId: this.config.machine?.id,`:

```ts
      executionLocation: request.workspace ? "laptop" : "cloud",
```

In `packages/host/src/server.ts` `/api/me`, change the `execution` property to:

```ts
      execution: { laptop: Boolean(config.agents.codex) && runtimeSecurity(config.deployment).tenancy === "single-tenant", cloudHandoff: Boolean(config.agents.codex) && runtimeSecurity(config.deployment).tenancy === "single-tenant", default: "cloud" as const },
```

In `apps/web/src/api.ts` `Session` type add `executionLocation?: "cloud" | "laptop";` after `machineId?: string;`. In `apps/mobile/src/api/client.ts` `SessionRow` add the same line after `machineId?: string;`.

- [ ] **Step 6: Write the failing API test**

Create `tests/cloud-default.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startHost } from "./helpers.js";

test("new sessions record cloud execution and /me reports the cloud default", { timeout: 30000 }, async () => {
  const host = await startHost();
  try {
    const me = await host.fetchApi("/me");
    assert.equal(me.body.execution.default, "cloud");
    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Cloud", prompt: "" });
    assert.equal(created.status, 201);
    assert.equal(created.body.executionLocation, "cloud");
    assert.equal(created.body.machineId, host.config.machine!.id);
    const row = (await host.fetchApi("/sessions")).body.sessions.find((s: { id: string }) => s.id === id);
    assert.equal(row.executionLocation, "cloud");
    const detail = await host.fetchApi(`/sessions/${id}`);
    assert.equal(detail.body.executionLocation, "cloud");
  } finally { await host.stop(); }
});
```

- [ ] **Step 7: Run it**

Run: `npx tsx --test tests/cloud-default.test.ts`
Expected: PASS. (If `machineId` is undefined on `host.config.machine`, read it from `me.body.machine.id` instead.)

- [ ] **Step 8: Update the client help text**

In `packages/host/src/client-entry.ts`, replace the lines

```
infinite [--include DIR] codex ["Initial prompt"]
infinite --cloud codex [native flags and prompt]
```

with

```
infinite --laptop [--include DIR] codex ["Initial prompt"]
```

and replace `Codex uses the invoking laptop directory by default; --cloud opts out.` with `Sessions run on the cloud machine. --laptop runs Codex tools in this directory with background cloud handoff.`

- [ ] **Step 9: Typecheck and run the full suite**

Run: `npm run typecheck && npm test`
Expected: all green. `tests/client-cli.test.ts` still passes because it launches with explicit args.

- [ ] **Step 10: Commit**

```bash
git add packages/host/src/types.ts packages/host/src/manager.ts packages/host/src/server.ts packages/host/src/client.ts packages/host/src/client-entry.ts apps/web/src/api.ts apps/mobile/src/api/client.ts tests/client-args.test.ts tests/cloud-default.test.ts
git commit -m "Default every provider to cloud execution and record execution location"
```

---

### Task 2: Project sync store (receive side) with pending and applied manifests

**Files:**
- Create: `packages/host/src/project-sync.ts`
- Test: `tests/project-sync.test.ts` (new)

**Interfaces:**
- Consumes: `captureWorkspace`, `materializeWorkspace`, `hasWorkspaceBlobs`, `putWorkspaceBlob`, `readWorkspaceBlob`, `validateWorkspaceManifest`, `WorkspaceManifest` from `./workspace-checkpoint.js`; `writeSealed`, `unseal` from `./vault.js`.
- Produces:

```ts
export interface ProjectSyncStatus {
  projectId: string;
  lastSyncedAt?: string;          // receivedAt of the newest committed manifest
  lastSyncedManifest?: string;    // its manifest id
  appliedAt?: string;
  appliedManifest?: string;
  pendingGeneration?: { id: string; capturedAt: string; receivedAt: string; reason: "session-running" | "cloud-changed" };
}
export class ProjectSyncError extends Error { constructor(message: string, readonly code: "cloud-changed" | "session-running" | "stale-generation" | "missing-content" | "invalid-manifest" | "unknown-project", readonly status = 409) }
export class ProjectSync {
  constructor(config: Config, key: Buffer);
  status(projectId: string): ProjectSyncStatus;
  begin(projectId: string): { generation: string };
  missing(projectId: string, hashes: string[]): Promise<string[]>;
  putBlob(projectId: string, hash: string, bytes: Buffer): Promise<void>;
  readBlob(projectId: string, hash: string): Promise<string>;   // base64
  commit(projectId: string, generation: string, manifest: unknown, running: boolean): Promise<ProjectSyncStatus>;
  apply(projectId: string, options: { force?: boolean; running: boolean }): Promise<ProjectSyncStatus>;
  exportTree(projectId: string): Promise<WorkspaceManifest>;
}
```

Storage layout under `config.stateDir/projects/<projectId>/sync/`: `blobs/` (content store), `received.sealed` (`{ manifest, receivedAt, generation }`), `applied.sealed` (`{ manifest, appliedAt }`), `scan/` (scratch store for drift scans). Scope strings for sealing: `project-sync:<projectId>:received` and `project-sync:<projectId>:applied`.

- [ ] **Step 1: Write the failing store tests**

Create `tests/project-sync.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { ProjectSync, ProjectSyncError } from "../packages/host/src/project-sync.js";
import { captureWorkspace, readWorkspaceBlob } from "../packages/host/src/workspace-checkpoint.js";
import { hashToken } from "../packages/host/src/config.js";
import type { Config } from "../packages/host/src/types.js";

function fixture() {
  const root = realpathSync(mkdtempSync("/tmp/inf-psync-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const cloud = join(root, "cloud"); mkdirSync(cloud);
  const key = randomBytes(32);
  const keyFile = join(root, "key"); writeFileSync(keyFile, key, { mode: 0o600 });
  const config: Config = {
    port: 0, origin: "http://127.0.0.1:1", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile,
    environment: "local", enableDemo: true, maxSessions: 24, agents: {},
    projects: [{ id: "example", name: "Example", path: cloud }],
    tokens: [{ id: "o", label: "o", role: "owner", hash: hashToken("x".repeat(40)) }],
  };
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  return { root, laptop, cloud, config, key, sync: new ProjectSync(config, key) };
}

/** Push the laptop tree the way the service will: capture, upload missing blobs, commit. */
async function push(f: ReturnType<typeof fixture>, running = false, previous?: Awaited<ReturnType<typeof captureWorkspace>>) {
  const storeDir = join(f.root, "laptop-store");
  const manifest = await captureWorkspace({ roots: [f.laptop], cwd: f.laptop, storeDir, previous });
  const { generation } = f.sync.begin("example");
  const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
  for (const hash of await f.sync.missing("example", hashes))
    await f.sync.putBlob("example", hash, Buffer.from(await readWorkspaceBlob(storeDir, hash), "base64"));
  return { manifest, status: await f.sync.commit("example", generation, manifest, running) };
}

test("first push applies onto an empty cloud directory and records both manifests", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "README.md"), "hello\n");
    mkdirSync(join(f.laptop, "src")); writeFileSync(join(f.laptop, "src/index.ts"), "export const a = 1;\n", { mode: 0o644 });
    const { manifest, status } = await push(f);
    assert.equal(status.lastSyncedManifest, manifest.id);
    assert.equal(status.appliedManifest, manifest.id);
    assert.equal(status.pendingGeneration, undefined);
    assert.equal(readFileSync(join(f.cloud, "src/index.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(readFileSync(join(f.cloud, "README.md"), "utf8"), "hello\n");
    assert.deepEqual(readdirSync(dirname(f.cloud)).filter(n => n.includes("infinite-stage")), [], "stage directories are removed after publication");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a non-empty cloud directory with no applied manifest needs force", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.cloud, "existing.txt"), "cloud-only\n");
    writeFileSync(join(f.laptop, "README.md"), "hello\n");
    const { status } = await push(f);
    assert.equal(status.pendingGeneration?.reason, "cloud-changed");
    assert.equal(readFileSync(join(f.cloud, "existing.txt"), "utf8"), "cloud-only\n", "nothing is applied without force");
    await assert.rejects(f.sync.apply("example", { running: false }), (error: ProjectSyncError) => error.code === "cloud-changed");
    const applied = await f.sync.apply("example", { running: false, force: true });
    assert.equal(applied.pendingGeneration, undefined);
    assert.equal(existsSync(join(f.cloud, "existing.txt")), false);
    const previous = join(dirname(f.cloud), `.${basename(f.cloud)}.infinite-previous`);
    assert.equal(readFileSync(join(previous, "existing.txt"), "utf8"), "cloud-only\n", "the replaced tree is kept once");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a running cloud session keeps the generation pending; apply later succeeds", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const first = await push(f);
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    const second = await push(f, true, first.manifest);
    assert.equal(second.status.pendingGeneration?.reason, "session-running");
    assert.equal(second.status.pendingGeneration?.id, second.manifest.id);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "1\n", "files are untouched while a session runs");
    await assert.rejects(f.sync.apply("example", { running: true }), (error: ProjectSyncError) => error.code === "session-running");
    const applied = await f.sync.apply("example", { running: false });
    assert.equal(applied.appliedManifest, second.manifest.id);
    assert.equal(readFileSync(join(f.cloud, "a.txt"), "utf8"), "2\n");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("host-side edits after apply make the next apply refuse without force", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const first = await push(f);
    writeFileSync(join(f.cloud, "agent-wrote.txt"), "cloud edit\n");
    writeFileSync(join(f.laptop, "a.txt"), "2\n");
    const second = await push(f, false, first.manifest);
    assert.equal(second.status.pendingGeneration?.reason, "cloud-changed");
    assert.equal(readFileSync(join(f.cloud, "agent-wrote.txt"), "utf8"), "cloud edit\n");
    const exported = await f.sync.exportTree("example");
    assert.ok(exported.entries.some(e => e.path === "agent-wrote.txt"), "export captures the live cloud tree");
    const forced = await f.sync.apply("example", { running: false, force: true });
    assert.equal(forced.appliedManifest, second.manifest.id);
    assert.equal(existsSync(join(f.cloud, "agent-wrote.txt")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("stale generations and missing content are refused", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.laptop, "a.txt"), "1\n");
    const storeDir = join(f.root, "laptop-store");
    const manifest = await captureWorkspace({ roots: [f.laptop], cwd: f.laptop, storeDir });
    const stale = f.sync.begin("example");
    f.sync.begin("example");
    await assert.rejects(f.sync.commit("example", stale.generation, manifest, false), (error: ProjectSyncError) => error.code === "stale-generation");
    const current = f.sync.begin("example");
    await assert.rejects(f.sync.commit("example", current.generation, manifest, false), (error: ProjectSyncError) => error.code === "missing-content");
    assert.throws(() => f.sync.status("nope"), (error: ProjectSyncError) => error.code === "unknown-project");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/project-sync.test.ts`
Expected: FAIL, module `project-sync.js` not found.

- [ ] **Step 3: Implement `project-sync.ts`**

Create `packages/host/src/project-sync.ts`:

```ts
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { unseal, writeSealed } from "./vault.js";
import {
  captureWorkspace, hasWorkspaceBlobs, materializeWorkspace, putWorkspaceBlob, readWorkspaceBlob,
  validateWorkspaceManifest, type WorkspaceEntry, type WorkspaceManifest,
} from "./workspace-checkpoint.js";
import type { Config } from "./types.js";

export interface ProjectSyncStatus {
  projectId: string;
  lastSyncedAt?: string;
  lastSyncedManifest?: string;
  appliedAt?: string;
  appliedManifest?: string;
  pendingGeneration?: { id: string; capturedAt: string; receivedAt: string; reason: "session-running" | "cloud-changed" };
}
type Received = { manifest: WorkspaceManifest; receivedAt: string; generation: string };
type Applied = { manifest: WorkspaceManifest; appliedAt: string };

export class ProjectSyncError extends Error {
  constructor(message: string, readonly code: "cloud-changed" | "session-running" | "stale-generation" | "missing-content" | "invalid-manifest" | "unknown-project", readonly status = 409) {
    super(message);
  }
}

const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
/** Paths Infinite itself owns inside a project; never part of drift detection. */
const OWNED_PREFIX = ".infinite";
const ownedPath = (path: string) => path === OWNED_PREFIX || path.startsWith(`${OWNED_PREFIX}/`);
const entrySignature = (entry: WorkspaceEntry) => JSON.stringify([entry.path, entry.kind, entry.mode, entry.size ?? null, entry.chunks ?? null, entry.target ?? null]);

/** One-way laptop-to-cloud synchronization state for configured projects. */
export class ProjectSync {
  private readonly generations = new Map<string, string>();
  private readonly serial = new Map<string, Promise<unknown>>();
  constructor(private readonly config: Config, private readonly key: Buffer) {}

  private project(projectId: string) {
    const project = this.config.projects.find(p => p.id === projectId);
    if (!project) throw new ProjectSyncError("Unknown project", "unknown-project", 404);
    return project;
  }
  private dir(projectId: string) {
    const dir = join(this.config.stateDir, "projects", projectId, "sync");
    mkdirSync(join(dir, "blobs"), { recursive: true, mode: 0o700 });
    return dir;
  }
  private read<T>(projectId: string, name: "received" | "applied"): T | undefined {
    const file = join(this.dir(projectId), `${name}.sealed`);
    return existsSync(file) ? unseal<T>(this.key, `project-sync:${projectId}:${name}`, readFileSync(file, "utf8")) : undefined;
  }
  private write(projectId: string, name: "received" | "applied", value: unknown) {
    writeSealed(join(this.dir(projectId), `${name}.sealed`), this.key, `project-sync:${projectId}:${name}`, value);
  }
  /** Serialize commit and apply per project; blob writes are content-addressed and need no lock. */
  private queue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(projectId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.serial.set(projectId, next.catch(() => {}));
    return next;
  }

  status(projectId: string): ProjectSyncStatus {
    this.project(projectId);
    const received = this.read<Received>(projectId, "received");
    const applied = this.read<Applied>(projectId, "applied");
    const status: ProjectSyncStatus = { projectId };
    if (received) { status.lastSyncedAt = received.receivedAt; status.lastSyncedManifest = received.manifest.id; }
    if (applied) { status.appliedAt = applied.appliedAt; status.appliedManifest = applied.manifest.id; }
    const pending = this.readPending(projectId);
    if (pending) status.pendingGeneration = pending;
    return status;
  }
  private readPending(projectId: string) {
    const file = join(this.dir(projectId), "pending.json");
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as ProjectSyncStatus["pendingGeneration"];
  }
  private writePending(projectId: string, value: ProjectSyncStatus["pendingGeneration"] | undefined) {
    const file = join(this.dir(projectId), "pending.json");
    if (!value) { if (existsSync(file)) void rm(file, { force: true }); return; }
    writeJson(file, value);
  }

  begin(projectId: string) {
    this.project(projectId);
    const generation = randomUUID();
    this.generations.set(projectId, generation);
    return { generation };
  }
  async missing(projectId: string, hashes: string[]) {
    if (!Array.isArray(hashes) || hashes.length > 512 || hashes.some(h => !/^[a-f0-9]{64}$/.test(h))) throw new ProjectSyncError("Invalid blob presence request", "invalid-manifest", 400);
    return hasWorkspaceBlobs(join(this.dir(projectId), "blobs"), hashes);
  }
  async putBlob(projectId: string, hash: string, bytes: Buffer) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ProjectSyncError("Invalid blob hash", "invalid-manifest", 400);
    await putWorkspaceBlob(join(this.dir(projectId), "blobs"), hash, bytes.toString("base64"));
  }
  readBlob(projectId: string, hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ProjectSyncError("Invalid blob hash", "invalid-manifest", 400);
    return readWorkspaceBlob(join(this.dir(projectId), "blobs"), hash);
  }

  commit(projectId: string, generation: string, value: unknown, running: boolean) {
    return this.queue(projectId, async () => {
      this.project(projectId);
      if (this.generations.get(projectId) !== generation) throw new ProjectSyncError("This sync generation is stale; begin again", "stale-generation");
      if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_MANIFEST_BYTES) throw new ProjectSyncError("Manifest exceeds the size limit", "invalid-manifest", 413);
      let manifest: WorkspaceManifest;
      try { manifest = validateWorkspaceManifest(value); } catch { throw new ProjectSyncError("Invalid workspace manifest", "invalid-manifest", 400); }
      if (manifest.roots.length !== 1) throw new ProjectSyncError("Project sync accepts exactly one root", "invalid-manifest", 400);
      const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
      if ((await hasWorkspaceBlobs(join(this.dir(projectId), "blobs"), hashes)).length) throw new ProjectSyncError("The manifest references content that was not uploaded", "missing-content");
      this.write(projectId, "received", { manifest, receivedAt: new Date().toISOString(), generation } satisfies Received);
      return this.applyReceived(projectId, { running });
    });
  }

  apply(projectId: string, options: { force?: boolean; running: boolean }) {
    return this.queue(projectId, () => this.applyReceived(projectId, options, true));
  }

  private async applyReceived(projectId: string, options: { force?: boolean; running: boolean }, explicit = false): Promise<ProjectSyncStatus> {
    const project = this.project(projectId);
    const received = this.read<Received>(projectId, "received");
    if (!received) return this.status(projectId);
    const applied = this.read<Applied>(projectId, "applied");
    if (applied?.manifest.id === received.manifest.id) { this.writePending(projectId, undefined); return this.status(projectId); }
    const pending = (reason: "session-running" | "cloud-changed") => {
      this.writePending(projectId, { id: received.manifest.id, capturedAt: received.manifest.capturedAt, receivedAt: received.receivedAt, reason });
      if (explicit) throw new ProjectSyncError(reason === "session-running" ? "A session is running in this project; stop it or wait before applying" : "The cloud workspace changed since the last applied generation; pull it or apply with force", reason);
      return this.status(projectId);
    };
    if (options.running) return pending("session-running");
    if (!options.force && await this.drifted(project.path, applied?.manifest)) return pending("cloud-changed");
    const target = await realpath(project.path);
    const parent = dirname(target), name = basename(target);
    const stage = join(parent, `.${name}.infinite-stage-${randomUUID()}`);
    const previous = join(parent, `.${name}.infinite-previous`);
    let published = false;
    try {
      const tree = await materializeWorkspace({ manifest: received.manifest, storeDir: join(this.dir(projectId), "blobs"), destination: stage });
      const source = tree.roots[0];
      const owned = join(target, OWNED_PREFIX);
      if (existsSync(owned)) await rename(owned, join(source, OWNED_PREFIX));
      await rm(previous, { recursive: true, force: true });
      await rename(target, previous);
      await rename(source, target);
      published = true;
      this.write(projectId, "applied", { manifest: received.manifest, appliedAt: new Date().toISOString() } satisfies Applied);
      this.writePending(projectId, undefined);
    } finally {
      if (published) await rm(stage, { recursive: true, force: true }).catch(() => {});
      else await rm(stage, { recursive: true, force: true }).catch(() => {});
    }
    return this.status(projectId);
  }

  /** The live cloud tree differs from the last applied generation, ignoring Infinite's own directory. */
  private async drifted(path: string, applied?: WorkspaceManifest): Promise<boolean> {
    const live = await this.scan(path);
    const liveEntries = live.entries.filter(e => !ownedPath(e.path) && e.path !== "");
    if (!applied) return liveEntries.length > 0;
    const expected = new Set(applied.entries.filter(e => !ownedPath(e.path) && e.path !== "").map(entrySignature));
    if (liveEntries.length !== expected.size) return true;
    return liveEntries.some(e => !expected.has(entrySignature(e)));
  }
  private async scan(path: string) {
    const root = await realpath(path);
    const info = await lstat(root);
    if (!info.isDirectory()) throw new ProjectSyncError("Configured project path is not a directory", "invalid-manifest", 500);
    const scratch = join(this.config.stateDir, "projects", basename(dirname(root)) === "" ? "root" : "", "scan");
    const storeDir = join(this.dir(this.config.projects.find(p => p.path === path)?.id ?? "unknown"), "scan");
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    void scratch;
    return captureWorkspace({ roots: [root], cwd: root, storeDir });
  }
  async exportTree(projectId: string): Promise<WorkspaceManifest> {
    const project = this.project(projectId);
    const root = await realpath(project.path);
    return captureWorkspace({ roots: [root], cwd: root, storeDir: join(this.dir(projectId), "blobs") });
  }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const { writeFileSync, renameSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}
```

Clean up the two leftovers before running: replace the body of `scan` with the three-line version below, and replace the `require` in `writeJson` with a top-level import.

```ts
  private async scan(projectId: string, path: string) {
    const root = await realpath(path);
    if (!(await lstat(root)).isDirectory()) throw new ProjectSyncError("Configured project path is not a directory", "invalid-manifest", 500);
    const storeDir = join(this.dir(projectId), "scan");
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    return captureWorkspace({ roots: [root], cwd: root, storeDir });
  }
```

Update the call in `drifted` to `this.scan(projectId, path)` and pass `projectId` into `drifted(projectId, project.path, applied?.manifest)`. At the top add `import { renameSync, writeFileSync } from "node:fs";` and use them in `writeJson` without `require`. Also delete the unused `readdirSync` import.

Note on `exportTree`: `captureWorkspace` writes chunks into `blobs/`, the same store the laptop pushes into, so `readBlob` serves export downloads with no second store.

- [ ] **Step 4: Run the store tests**

Run: `npx tsx --test tests/project-sync.test.ts`
Expected: PASS (5 tests). If `materializeWorkspace` refuses because the stage parent is under a root it is syncing, check that `stage` is created as a sibling of the project path, not inside it.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/project-sync.ts tests/project-sync.test.ts
git commit -m "Add one-way project sync store with pending and applied generations"
```

---

### Task 3: Sync API routes, project detail route, relay allowlist

**Files:**
- Modify: `packages/host/src/server.ts` (json limit middleware at `:95-96`; new routes before the `/api` 404 handler at `:560`; export `projectSync` on the returned object)
- Modify: `packages/host/src/remote-access.ts:22-35` (`allowedPath`)
- Test: `tests/project-sync-api.test.ts` (new); extend `tests/remote-sessions.test.ts` if it has an `allowedPath` table (search for `allowedPath`; if absent, skip)

**Interfaces:**
- Consumes: `ProjectSync` from Task 2; `Manager.list()` rows carry `projectId`, `status`, `executionLocation`.
- Produces routes (all under owner unless noted):

| Method | Path | Body / Result |
| --- | --- | --- |
| GET | `/api/projects/:id` (any role) | `{ id, name, sync: ProjectSyncStatus }` |
| POST | `/api/projects/:id/sync/begin` | `{}` → `{ generation }` |
| POST | `/api/projects/:id/sync/has` | `{ hashes: string[] }` → `{ missing: string[] }` |
| PUT | `/api/projects/:id/sync/blob/:hash` | raw `application/octet-stream` ≤ 1 MiB → `{ stored: true }` |
| POST | `/api/projects/:id/sync/commit` | `{ generation, manifest }` (json limit 32 MiB) → `ProjectSyncStatus` |
| POST | `/api/projects/:id/sync/apply` | `{ force?: boolean }` → `ProjectSyncStatus` |
| POST | `/api/projects/:id/sync/export` | `{}` → `{ manifest }` |
| GET | `/api/projects/:id/sync/blob/:hash` | → `{ base64 }` |

Only `GET /api/projects/:id` and `POST .../sync/apply` are added to the relay allowlist. Blob and manifest transfer stay direct.

- [ ] **Step 1: Write the failing API test**

Create `tests/project-sync-api.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { captureWorkspace, readWorkspaceBlob } from "../packages/host/src/workspace-checkpoint.js";
import { startHost, waitFor } from "./helpers.js";

async function pushTree(host: Awaited<ReturnType<typeof startHost>>, laptop: string, storeDir: string) {
  const manifest = await captureWorkspace({ roots: [laptop], cwd: laptop, storeDir });
  const begin = await host.fetchApi("/projects/rehearsal/sync/begin", "owner", {});
  assert.equal(begin.status, 200);
  const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
  const has = await host.fetchApi("/projects/rehearsal/sync/has", "owner", { hashes });
  for (const hash of has.body.missing as string[]) {
    const response = await fetch(`${host.origin}/api/projects/rehearsal/sync/blob/${hash}`, {
      method: "PUT", headers: { Authorization: `Bearer ${host.tokens.owner}`, "Content-Type": "application/octet-stream" },
      body: Buffer.from(await readWorkspaceBlob(storeDir, hash), "base64"),
    });
    assert.equal(response.status, 200);
  }
  return { manifest, commit: await host.fetchApi("/projects/rehearsal/sync/commit", "owner", { generation: begin.body.generation, manifest }) };
}

test("sync routes receive a laptop tree, hold it while a session runs, and apply on request", { timeout: 60000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-psync-api-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const storeDir = join(root, "store");
  try {
    assert.equal((await host.fetchApi("/projects/rehearsal", "viewer")).status, 200);
    assert.equal((await host.fetchApi("/projects/rehearsal/sync/begin", "controller", {})).status, 403);
    writeFileSync(join(laptop, "notes.md"), "v1\n");
    const first = await pushTree(host, laptop, storeDir);
    assert.equal(first.commit.status, 200);
    assert.equal(first.commit.body.appliedManifest, first.manifest.id, "idle project applies immediately");
    assert.equal(readFileSync(join(host.config.projects[0].path, "notes.md"), "utf8"), "v1\n");

    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Busy", prompt: "" });
    assert.equal(created.status, 201);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "running");
    writeFileSync(join(laptop, "notes.md"), "v2\n");
    const second = await pushTree(host, laptop, storeDir);
    assert.equal(second.commit.body.pendingGeneration?.reason, "session-running");
    assert.equal(readFileSync(join(host.config.projects[0].path, "notes.md"), "utf8"), "v1\n");
    const refused = await host.fetchApi("/projects/rehearsal/sync/apply", "owner", {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "session-running");

    const stop = await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() });
    assert.equal(stop.status, 200);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "exited");
    const applied = await host.fetchApi("/projects/rehearsal/sync/apply", "owner", {});
    assert.equal(applied.status, 200);
    assert.equal(applied.body.appliedManifest, second.manifest.id);
    assert.equal(readFileSync(join(host.config.projects[0].path, "notes.md"), "utf8"), "v2\n");
    const detail = await host.fetchApi("/projects/rehearsal");
    assert.equal(detail.body.sync.appliedManifest, second.manifest.id);
    assert.equal(detail.body.sync.pendingGeneration, undefined);

    const exported = await host.fetchApi("/projects/rehearsal/sync/export", "owner", {});
    assert.equal(exported.status, 200);
    const hash = exported.body.manifest.entries.find((e: { path: string }) => e.path === "notes.md").chunks[0];
    const blob = await host.fetchApi(`/projects/rehearsal/sync/blob/${hash}`);
    assert.equal(Buffer.from(blob.body.base64, "base64").toString(), "v2\n");
  } finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
});
```

Note: the demo provider ignores the `/stop` keystroke path only if the worker handles it; the existing suites use `/stop` on demo sessions successfully, so this is safe.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/project-sync-api.test.ts`
Expected: FAIL with 404 on `/projects/rehearsal`.

- [ ] **Step 3: Add routes**

In `packages/host/src/server.ts`:

Add imports: `import { ProjectSync, ProjectSyncError } from "./project-sync.js";` and `import { z } from "zod";` is already present.

After `const manager = new Manager(config, key);` add `const projectSync = new ProjectSync(config, key);` and a helper:

```ts
  const projectRunning = async (projectId: string) =>
    (await manager.list()).some(s => s.projectId === projectId && ["running", "starting"].includes(s.status) && s.executionLocation !== "laptop");
  const projectSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);
```

Replace the json middleware line with:

```ts
  app.use((req, res, next) => express.json({ limit: /^\/api\/sessions\/[^/]+\/opencode(?:\/|$)/.test(req.path) ? "8mb"
    : /^\/api\/projects\/[^/]+\/sync\/commit$/.test(req.path) ? "32mb" : "96kb" })(req, res, next));
```

Before `app.get("/api/projects/:id/context", ...)` add:

```ts
  app.get("/api/projects/:id", (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    const project = config.projects.find(p => p.id === projectId);
    if (!project) return res.status(404).json({ error: "Unknown project" });
    return res.json({ id: project.id, name: project.name, sync: projectSync.status(projectId) });
  });
  app.post("/api/projects/:id/sync/begin", requireRole(["owner"]), (req, res) => {
    if (!res.locals.bearer) return res.status(403).json({ error: "Workspace sync requires a paired owner CLI" });
    return res.json(projectSync.begin(projectSchema.parse(req.params.id)));
  });
  app.post("/api/projects/:id/sync/has", requireRole(["owner"]), async (req, res) => {
    const body = z.object({ hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(512) }).strict().parse(req.body);
    res.json({ missing: await projectSync.missing(projectSchema.parse(req.params.id), body.hashes) });
  });
  app.put("/api/projects/:id/sync/blob/:hash", requireRole(["owner"]), express.raw({ type: "application/octet-stream", limit: "1mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return void res.status(400).json({ error: "Send the chunk as application/octet-stream" });
    await projectSync.putBlob(projectSchema.parse(req.params.id), String(req.params.hash), req.body);
    res.json({ stored: true });
  });
  app.post("/api/projects/:id/sync/commit", requireRole(["owner"]), async (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    const body = z.object({ generation: z.uuid(), manifest: z.unknown() }).strict().parse(req.body);
    res.json(await projectSync.commit(projectId, body.generation, body.manifest, await projectRunning(projectId)));
  });
  app.post("/api/projects/:id/sync/apply", requireRole(["owner"]), async (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    const body = z.object({ force: z.boolean().optional() }).strict().parse(req.body ?? {});
    res.json(await projectSync.apply(projectId, { force: body.force, running: await projectRunning(projectId) }));
  });
  app.post("/api/projects/:id/sync/export", requireRole(["owner"]), async (req, res) => {
    if (!res.locals.bearer) return void res.status(403).json({ error: "Workspace export requires a paired owner CLI" });
    res.json({ manifest: await projectSync.exportTree(projectSchema.parse(req.params.id)) });
  });
  app.get("/api/projects/:id/sync/blob/:hash", requireRole(["owner"]), async (req, res) => {
    res.json({ base64: await projectSync.readBlob(projectSchema.parse(req.params.id), String(req.params.hash)) });
  });
```

In the error handler, before the `ContentError` branch add:

```ts
      if (error instanceof ProjectSyncError) return res.status(error.status).json({ code: error.code, error: error.message });
```

Add `projectSync` to the returned object: `return { app, manager, projectSync, sessions: { list: listSessions }, pushStore, server, closeConnections };`.

In `packages/host/src/remote-access.ts` `allowedPath`, add after the context line:

```ts
  if (method === "GET" && /^\/api\/projects\/[a-z0-9-]{1,80}$/.test(url.pathname)) return true;
  if (method === "POST" && /^\/api\/projects\/[a-z0-9-]{1,80}\/sync\/apply$/.test(url.pathname)) return true;
```

- [ ] **Step 4: Run the API test and the remote suites**

Run: `npx tsx --test tests/project-sync-api.test.ts tests/remote-access.test.ts tests/remote-sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/server.ts packages/host/src/remote-access.ts tests/project-sync-api.test.ts
git commit -m "Expose project sync, apply, and export routes"
```

---

### Task 4: Laptop sync service

**Files:**
- Create: `packages/host/src/sync-service.ts`
- Modify: `packages/host/src/client-entry.ts:4-7` (dispatch the detached entry)
- Test: `tests/sync-service.test.ts` (new)

**Interfaces:**
- Consumes: Task 3 routes; `captureWorkspace`, `readWorkspaceBlob` from `./workspace-checkpoint.js`.
- Produces:

```ts
export interface SyncServiceOptions { origin: string; token: string; projectId: string; root: string; stateFile: string; storeDir: string }
export async function startSyncService(options: SyncServiceOptions): Promise<void>;   // spawns the detached child, resolves after its first successful commit
export function readSyncState(stateFile: string): { pid: number; projectId: string; root: string; origin: string; startedAt: string; lastCommitAt?: string; lastManifest?: string; problem?: string } | undefined;
export function stopSyncService(stateFile: string): boolean;   // SIGTERM by pid, removes the state file
```

The child is the same bundle (`client-entry.js`) started with `--sync-service`, bootstrapped over IPC exactly like `laptop-service.ts` (`boot` → `start` → `ready` → `detach` → `detached`). Credentials travel only over IPC.

- [ ] **Step 1: Write the failing service test**

Create `tests/sync-service.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startSyncService, readSyncState, stopSyncService } from "../packages/host/src/sync-service.js";
import { startHost, waitFor } from "./helpers.js";

test("the detached sync service pushes edits, stays pending while a session runs, and stops on request", { timeout: 90000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-syncsvc-"));
  const laptop = join(root, "laptop"); mkdirSync(laptop);
  const stateFile = join(root, "sync", "rehearsal.json");
  const storeDir = join(root, "sync", "rehearsal-store");
  try {
    writeFileSync(join(laptop, "app.ts"), "one\n");
    await startSyncService({ origin: host.origin, token: host.tokens.owner, projectId: "rehearsal", root: laptop, stateFile, storeDir });
    const state = readSyncState(stateFile)!;
    assert.ok(state.pid > 0);
    assert.equal(state.root, laptop);
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => Boolean(r.body.sync.appliedManifest), 20000);
    assert.equal(readFileSync(join(host.config.projects[0].path, "app.ts"), "utf8"), "one\n");

    writeFileSync(join(laptop, "app.ts"), "two\n");
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => readFileSync(join(host.config.projects[0].path, "app.ts"), "utf8") === "two\n" && !r.body.sync.pendingGeneration, 20000);

    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Busy", prompt: "" });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "running");
    writeFileSync(join(laptop, "app.ts"), "three\n");
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => r.body.sync.pendingGeneration?.reason === "session-running", 20000);
    assert.equal(readFileSync(join(host.config.projects[0].path, "app.ts"), "utf8"), "two\n");

    assert.equal(stopSyncService(stateFile), true);
    assert.equal(existsSync(stateFile), false);
    await waitFor(async () => { try { process.kill(state.pid, 0); return true; } catch { return false; } }, alive => alive === false, 10000);
  } finally {
    if (existsSync(stateFile)) stopSyncService(stateFile);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/sync-service.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `sync-service.ts`**

Create `packages/host/src/sync-service.ts`:

```ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { captureWorkspace, readWorkspaceBlob, type WorkspaceManifest } from "./workspace-checkpoint.js";

export interface SyncServiceOptions { origin: string; token: string; projectId: string; root: string; stateFile: string; storeDir: string }
export interface SyncState { pid: number; projectId: string; root: string; origin: string; startedAt: string; lastCommitAt?: string; lastManifest?: string; problem?: string }

const STARTUP_TIMEOUT = 60000;
const STARTUP_ERROR = "The workspace sync service did not complete its first upload. Nothing was applied on the host.";
const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function validateOptions(options: SyncServiceOptions): SyncServiceOptions {
  const origin = new URL(options.origin);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))) ||
      !/^[a-z0-9-]{1,80}$/.test(options.projectId) || !/^[\x21-\x7e]{32,200}$/.test(options.token)) throw new Error("Invalid sync pairing.");
  const root = realpathSync(options.root);
  if (!statSync(root).isDirectory() || root === sep || root === realpathSync(homedir())) throw new Error("Select a project directory, not the entire home or filesystem.");
  const storeDir = resolve(options.storeDir), stateFile = resolve(options.stateFile);
  if (inside(root, storeDir) || inside(root, stateFile)) throw new Error("Sync storage must be outside the synced project.");
  return { ...options, origin: origin.origin, root, storeDir, stateFile };
}

export function readSyncState(stateFile: string): SyncState | undefined {
  if (!existsSync(stateFile)) return undefined;
  return JSON.parse(readFileSync(stateFile, "utf8")) as SyncState;
}
function writeState(stateFile: string, state: SyncState) {
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, stateFile);
}
export function stopSyncService(stateFile: string): boolean {
  const state = readSyncState(stateFile);
  if (!state) return false;
  try { process.kill(state.pid, "SIGTERM"); } catch { /* already gone */ }
  rmSync(stateFile, { force: true });
  return true;
}

/** Launch the detached service and resolve after its first committed generation. */
export async function startSyncService(options: SyncServiceOptions): Promise<void> {
  const validated = validateOptions(options);
  const existing = readSyncState(validated.stateFile);
  if (existing) { try { process.kill(existing.pid, 0); throw new Error("A sync service already runs for this project. Stop it first."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; rmSync(validated.stateFile, { force: true }); } }
  const file = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...(file.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []), file, "--sync-service"], {
    cwd: validated.root, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await new Promise<void>((resolve, reject) => {
    let started = false, ready = false, detached = false, finished = false;
    const timer = setTimeout(() => fail(), STARTUP_TIMEOUT);
    const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("disconnect", disconnected); child.off("exit", fail); child.off("error", fail); };
    const fail = () => {
      if (finished) return;
      finished = true; cleanup();
      if (child.connected) try { child.disconnect(); } catch { /* gone */ }
      child.kill("SIGTERM");
      reject(new Error(STARTUP_ERROR));
    };
    const disconnected = () => { if (!detached) { fail(); return; } if (finished) return; finished = true; cleanup(); child.unref(); resolve(); };
    const message = (value: unknown) => {
      const type = (value as { type?: unknown })?.type;
      if (type === "boot" && !started) { started = true; child.send({ type: "start", options: validated }, error => { if (error) fail(); }); return; }
      if (type === "detached" && ready && !detached) { detached = true; return; }
      if (type !== "ready" || !started || ready) { fail(); return; }
      ready = true;
      child.send({ type: "detach" }, error => { if (error) fail(); });
    };
    child.on("error", fail); child.on("exit", fail); child.on("disconnect", disconnected); child.on("message", message);
  });
}

async function api(options: SyncServiceOptions, path: string, init: { method?: string; body?: unknown; raw?: Buffer; signal?: AbortSignal }) {
  const response = await fetch(options.origin + "/api" + path, {
    method: init.method ?? (init.body !== undefined || init.raw ? (init.raw ? "PUT" : "POST") : "GET"), redirect: "error",
    headers: { Authorization: `Bearer ${options.token}`, ...(init.raw ? { "Content-Type": "application/octet-stream" } : init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    signal: init.signal ?? AbortSignal.timeout(60000),
  });
  if ([401, 403, 404].includes(response.status)) throw Object.assign(new Error(`Host refused sync (${response.status})`), { fatal: true });
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { code?: string; error?: string }; throw new Error(body.error ?? `HTTP ${response.status}`); }
  return response.json() as Promise<any>;
}

async function runSyncService(): Promise<void> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, stop);
  let options: SyncServiceOptions | undefined;
  try {
    options = await new Promise<SyncServiceOptions>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(STARTUP_ERROR)), STARTUP_TIMEOUT);
      process.once("message", (message: { type?: string; options?: SyncServiceOptions }) => {
        clearTimeout(timer);
        try { if (message?.type !== "start" || !message.options) throw new Error(STARTUP_ERROR); resolve(validateOptions(message.options)); } catch (error) { reject(error); }
      });
      process.send?.({ type: "boot" });
    });
    const state: SyncState = { pid: process.pid, projectId: options.projectId, root: options.root, origin: options.origin, startedAt: new Date().toISOString() };
    writeState(options.stateFile, state);
    process.on("disconnect", () => { /* detached: keep running */ });
    process.on("message", (message: { type?: string }) => { if (message?.type === "detach") { process.send?.({ type: "detached" }, () => { if (process.connected) process.disconnect(); }); } });
    let previous: WorkspaceManifest | undefined, lastFull = 0, reported = false, failures = 0;
    while (!abort.signal.aborted) {
      try {
        const forceFull = Date.now() - lastFull > 60000;
        const manifest = await captureWorkspace({ roots: [options.root], cwd: options.root, storeDir: options.storeDir, signal: abort.signal, previous, forceFull });
        if (manifest.id !== previous?.id) {
          const { generation } = await api(options, `/projects/${options.projectId}/sync/begin`, { body: {} });
          const hashes = [...new Set(manifest.entries.flatMap(e => e.chunks ?? []))];
          for (let offset = 0; offset < hashes.length; offset += 512) {
            const { missing } = await api(options, `/projects/${options.projectId}/sync/has`, { body: { hashes: hashes.slice(offset, offset + 512) } });
            for (const hash of missing as string[]) {
              if (abort.signal.aborted) return;
              await api(options, `/projects/${options.projectId}/sync/blob/${hash}`, { raw: Buffer.from(await readWorkspaceBlob(options.storeDir, hash), "base64") });
            }
          }
          await api(options, `/projects/${options.projectId}/sync/commit`, { body: { generation, manifest } });
          previous = manifest;
          state.lastCommitAt = new Date().toISOString(); state.lastManifest = manifest.id; delete state.problem;
          writeState(options.stateFile, state);
          failures = 0;
        }
        if (forceFull) lastFull = Date.now();
        if (!reported) { reported = true; process.send?.({ type: "ready" }); }
      } catch (error) {
        if ((error as { fatal?: boolean }).fatal) { state.problem = (error as Error).message; writeState(options.stateFile, state); break; }
        failures += 1;
        state.problem = (error as Error).message.slice(0, 200); writeState(options.stateFile, state);
        if (!reported && failures > 5) break;
      }
      if (!existsSync(options.stateFile)) break;
      await delay(3000, undefined, { signal: abort.signal }).catch(() => {});
    }
  } catch { process.exitCode = 1; }
  finally {
    if (options && existsSync(options.stateFile) && readSyncState(options.stateFile)?.pid === process.pid) rmSync(options.stateFile, { force: true });
    if (process.connected) { try { process.send?.({ type: "failed" }, () => process.disconnect()); } catch { /* parent gone */ } }
  }
}

if (process.argv[2] === "--sync-service" && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.send)
  void runSyncService();
```

In `packages/host/src/client-entry.ts`, change the guard to also skip the parser for the sync service:

```ts
if (!((process.argv[2] === "--laptop-service" || process.argv[2] === "--sync-service") && process.send) && !await handleClientCommand(process.argv.slice(2))) {
```

Because the bundled `client-entry.js` is the installed entry, add `import "./sync-service.js";` next to the existing laptop-service import chain only if `client.ts` does not already import `sync-service.ts` (Task 5 adds that import, which is enough).

- [ ] **Step 4: Run the service test**

Run: `npx tsx --test tests/sync-service.test.ts`
Expected: PASS. If the child never sends `ready`, run the service inline with `INFINITE_DEBUG=1` is not available; instead check `readSyncState(stateFile).problem` in a temporary `console.log` and remove it afterwards.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/sync-service.ts packages/host/src/client-entry.ts tests/sync-service.test.ts
git commit -m "Add the detached laptop workspace sync service"
```

---

### Task 5: CLI commands `sync`, `pull`, and project listing with sync age

**Files:**
- Modify: `packages/host/src/client.ts` (`CLIENT_COMMANDS`, `parseClientArgs` booleans, `handleClientCommand` branches, `printSessions` unchanged)
- Modify: `packages/host/src/client-entry.ts` help text
- Test: extend `tests/client-args.test.ts`; `tests/sync-cli.test.ts` (new)

**Interfaces:**
- Consumes: `startSyncService`, `readSyncState`, `stopSyncService` (Task 4); routes from Task 3.
- Produces CLI:

```
infinite sync [--project ID]            # start the detached sync service for the Git root of the current directory
infinite sync --stop [--project ID]
infinite sync --status
infinite sync --apply [--force] [--project ID]
infinite pull [PROJECT_ID] [--output DIR]   # download the current cloud project tree into a new directory
infinite projects                        # now prints: ID  NAME  · synced 3m ago · pending (session running)
```

Sync state lives at `dirname(clientConfig)/sync/<projectId>.json`; its blob store at `dirname(clientConfig)/sync/<projectId>-store/`.

- [ ] **Step 1: Extend the parse tests**

Append to `tests/client-args.test.ts`:

```ts
test("sync and pull commands parse their options", () => {
  const start = parseClientArgs(["sync", "--project", "example"]);
  assert.equal(start.command, "sync"); assert.equal(start.options["--project"], "example");
  const stop = parseClientArgs(["sync", "--stop"]);
  assert.equal(stop.options["--stop"], true);
  const apply = parseClientArgs(["sync", "--apply", "--force"]);
  assert.equal(apply.options["--apply"], true); assert.equal(apply.options["--force"], true);
  const pull = parseClientArgs(["pull", "example", "--output", "/tmp/x"]);
  assert.deepEqual(pull.args, ["example"]); assert.equal(pull.options["--output"], "/tmp/x");
  assert.throws(() => parseClientArgs(["--include", "../lib", "sync"]), /--include applies to --laptop/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/client-args.test.ts`
Expected: FAIL on unknown option `--stop`.

- [ ] **Step 3: Implement the commands**

In `packages/host/src/client.ts`:

- Add `"sync", "pull"` to `CLIENT_COMMANDS` and to the `candidate` detection array in `handleClientCommand`.
- Add `"--stop", "--status", "--apply", "--force"` to `booleans` in `parseClientArgs`.
- Add imports: `import { readSyncState, startSyncService, stopSyncService } from "./sync-service.js";`.
- Add a helper above `handleClientCommand`:

```ts
function gitRoot(cwd: string) {
  try { return realpathSync(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim()); }
  catch { return cwd; }
}
function age(iso?: string) {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}
type ProjectDetail = { id: string; name: string; sync: { lastSyncedAt?: string; appliedAt?: string; appliedManifest?: string; pendingGeneration?: { reason: string; receivedAt: string } } };
function describeSync(sync: ProjectDetail["sync"]) {
  const pending = sync.pendingGeneration ? ` · pending (${sync.pendingGeneration.reason === "session-running" ? "session running" : "cloud changed; use infinite sync --apply --force or infinite pull"})` : "";
  return `synced ${age(sync.lastSyncedAt)} · applied ${age(sync.appliedAt)}${pending}`;
}
```

- Replace the `projects` branch with:

```ts
    if (command === "projects") {
      for (const p of me.projects) {
        const detail = await api.json<ProjectDetail>(`/projects/${p.id}`).catch(() => undefined);
        console.log(`${p.id}  ${clean(p.name)}${detail ? `  · ${describeSync(detail.sync)}` : ""}`);
      }
      return true;
    }
```

- Add, after the `recover` branch:

```ts
    if (command === "sync") {
      if (me.role !== "owner") throw new Error("Workspace sync requires an owner device key");
      const syncDir = join(dirname(path), "sync");
      if (options["--status"]) {
        for (const p of me.projects) {
          const state = readSyncState(join(syncDir, `${p.id}.json`));
          const detail = await api.json<ProjectDetail>(`/projects/${p.id}`).catch(() => undefined);
          console.log(`${p.id}  ${state ? `service pid ${state.pid} · ${clean(state.root)}${state.problem ? ` · problem: ${clean(state.problem)}` : ""}` : "no local service"}${detail ? ` · ${describeSync(detail.sync)}` : ""}`);
        }
        return true;
      }
      const projectId = String(options["--project"] ?? config.projectId ?? me.projects[0]?.id ?? "");
      if (!me.projects.some(p => p.id === projectId)) throw new Error("Unknown project. Use infinite projects");
      const stateFile = join(syncDir, `${projectId}.json`);
      if (options["--stop"]) { console.log(stopSyncService(stateFile) ? "Sync service stopped. The cloud copy keeps its last applied generation." : "No sync service was running for this project."); return true; }
      if (options["--apply"]) {
        const result = await api.json<ProjectDetail["sync"]>(`/projects/${projectId}/sync/apply`, options["--force"] ? { force: true } : {});
        console.log(describeSync(result)); return true;
      }
      const root = gitRoot(realpathSync(process.cwd()));
      if (root === realpathSync(homedir()) || root === dirname(root)) throw new Error("Run inside a project directory; selecting the entire home or filesystem is not supported");
      progress.start(`Uploading ${clean(root)} to project ${projectId}`);
      await startSyncService({ origin: config.origin, token: config.token, projectId, root, stateFile, storeDir: join(syncDir, `${projectId}-store`) });
      progress.stop();
      const detail = await api.json<ProjectDetail>(`/projects/${projectId}`);
      console.error(`[Infinite] Sync service running for ${clean(root)} → ${projectId}. ${describeSync(detail.sync)}. It keeps running after this command exits; stop it with infinite sync --stop.`);
      return true;
    }
    if (command === "pull") {
      if (me.role !== "owner") throw new Error("Workspace pull requires an owner device key");
      const projectId = positional[0] ?? String(config.projectId ?? me.projects[0]?.id ?? "");
      if (!me.projects.some(p => p.id === projectId)) throw new Error("Unknown project. Use infinite projects");
      progress.start("Downloading the cloud project tree");
      const { manifest: exported } = await api.json<{ manifest: unknown }>(`/projects/${projectId}/sync/export`, {}, AbortSignal.timeout(300000));
      const manifest = validateWorkspaceManifest(exported);
      const directory = join(dirname(path), "pulls", projectId), storeDir = join(directory, "objects");
      const hashes = [...new Set(manifest.entries.flatMap(entry => entry.chunks ?? []))];
      for (let offset = 0; offset < hashes.length; offset += 512)
        for (const hash of await hasWorkspaceBlobs(storeDir, hashes.slice(offset, offset + 512))) {
          const { base64 } = await api.json<{ base64: string }>(`/projects/${projectId}/sync/blob/${hash}`);
          await putWorkspaceBlob(storeDir, hash, base64);
        }
      const destination = resolve(String(options["--output"] ?? join(directory, manifest.id)));
      const pulled = await materializeWorkspace({ manifest, storeDir, destination });
      progress.stop();
      console.log(pulled.cwd);
      console.error("[Infinite] Cloud project downloaded into a new directory. Compare it with your checkout; nothing on this Mac was overwritten.");
      return true;
    }
```

Note the `pull` destination prints `pulled.cwd`, which is `DESTINATION/workspace/<cloud root path>`; this mirrors `recover`. Keep it.

- Update `client-entry.ts` help: add after the `recover` line

```
infinite sync [--project ID] | --stop | --status | --apply [--force]
infinite pull [PROJECT_ID] [--output NEW_DIRECTORY]
```

and the sentence `Sync keeps the cloud project current with this checkout, one way; pull downloads the cloud copy.`

- [ ] **Step 4: Write a CLI-level sync test**

Create `tests/sync-cli.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { startHost, waitFor } from "./helpers.js";
import { readSyncState, stopSyncService } from "../packages/host/src/sync-service.js";

const exec = promisify(execFile);

test("infinite sync, projects, and pull round-trip a checkout through the host", { timeout: 120000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-synccli-"));
  const checkout = join(root, "checkout"); mkdirSync(checkout);
  const clientFile = join(root, "client.json"), tokenFile = join(root, "owner.key");
  writeFileSync(tokenFile, host.tokens.owner, { mode: 0o600 });
  const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/cli.ts"), "--client-config", clientFile];
  const stateFile = join(root, "sync", "rehearsal.json");
  try {
    await exec(process.execPath, [...cli, "pair", host.origin, "--token-file", tokenFile]);
    writeFileSync(join(checkout, "file.txt"), "from laptop\n");
    await exec(process.execPath, [...cli, "sync", "--project", "rehearsal"], { cwd: checkout });
    assert.ok(readSyncState(stateFile));
    await waitFor(() => host.fetchApi("/projects/rehearsal"), r => Boolean(r.body.sync.appliedManifest), 30000);
    assert.equal(readFileSync(join(host.config.projects[0].path, "file.txt"), "utf8"), "from laptop\n");
    const listed = await exec(process.execPath, [...cli, "projects"]);
    assert.match(listed.stdout, /rehearsal\s+Rehearsal\s+· synced \d+s ago/);

    writeFileSync(join(host.config.projects[0].path, "cloud.txt"), "from cloud\n");
    const output = join(root, "pulled");
    const pulled = await exec(process.execPath, [...cli, "pull", "rehearsal", "--output", output]);
    const cwd = pulled.stdout.trim();
    assert.equal(readFileSync(join(cwd, "cloud.txt"), "utf8"), "from cloud\n");
    assert.equal(existsSync(join(checkout, "cloud.txt")), false, "pull never writes into the checkout");

    const stopped = await exec(process.execPath, [...cli, "sync", "--stop", "--project", "rehearsal"]);
    assert.match(stopped.stdout, /stopped/);
  } finally {
    if (existsSync(stateFile)) stopSyncService(stateFile);
    await host.stop(); rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Run the tests**

Run: `npx tsx --test tests/client-args.test.ts tests/sync-cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/client.ts packages/host/src/client-entry.ts tests/client-args.test.ts tests/sync-cli.test.ts
git commit -m "Add infinite sync and pull commands with sync age in project listings"
```

---

### Task 6: Show execution location and sync state on web and phone

**Files:**
- Modify: `apps/web/src/api.ts` (add `ProjectDetail` type), `apps/web/src/main.tsx:945-953` (session meta), `apps/web/src/main.tsx:609-618` (workspace select in Create)
- Modify: `apps/mobile/src/api/client.ts` (add `ProjectDetail` type), `apps/mobile/src/features/session/Brief.tsx:168-176`, `apps/mobile/src/features/create/Create.tsx:60-62`

**Interfaces:**
- Consumes: `GET /api/projects/:id` → `{ id, name, sync }`, `POST /api/projects/:id/sync/apply`; `Session.executionLocation`.

- [ ] **Step 1: Web types and session meta**

In `apps/web/src/api.ts` add:

```ts
export type ProjectSyncStatus = { projectId: string; lastSyncedAt?: string; appliedAt?: string; appliedManifest?: string; pendingGeneration?: { id: string; capturedAt: string; receivedAt: string; reason: "session-running" | "cloud-changed" } };
export type ProjectDetail = { id: string; name: string; sync: ProjectSyncStatus };
export function ago(iso?: string, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}
```

In `apps/web/src/main.tsx` session heading, change the first `session-meta` paragraph to:

```tsx
          <p className="session-meta">
            Tools run on {session.executionLocation === "laptop" ? "your laptop" : me.machine?.label || "this machine"} <span>·</span>{" "}
            Started {time(session.createdAt)} <span>·</span>{" "}
            {session.pid ? `PID ${session.pid}` : "No live process"}
          </p>
```

Keep the existing `session.execution` block as is (it only renders for `--laptop` sessions).

- [ ] **Step 2: Web Create: sync line and Apply button**

In the Create component, after `const [projectId, setProjectId] = ...` add:

```tsx
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const load = () => api<ProjectDetail>(`/projects/${projectId}`).then(detail => { if (active) setProject(detail); }).catch(() => { if (active) setProject(null); });
    void load();
    const timer = setInterval(load, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [api, projectId]);
  async function applyPending(force: boolean) {
    if (!projectId || applying) return;
    setApplying(true);
    try { setProject(previous => previous ? { ...previous, sync: undefined as never } : previous); await api(`/projects/${projectId}/sync/apply`, force ? { force } : {}); }
    catch (error) { setError((error as Error).message); }
    finally { setApplying(false); }
  }
```

Replace the `setProject(previous => ...)` line with nothing (remove it; the poll refreshes). Under the workspace `<select>` add:

```tsx
          {project && (
            <p className="quiet" role="status">
              Synced from laptop {ago(project.sync.lastSyncedAt)} · applied {ago(project.sync.appliedAt)}
              {project.sync.pendingGeneration && <> · pending: {project.sync.pendingGeneration.reason === "session-running" ? "a session is running" : "cloud files changed"}{" "}
                {me.role === "owner" && <button type="button" className="text-button" disabled={applying} onClick={() => void applyPending(project.sync.pendingGeneration!.reason === "cloud-changed")}>
                  {project.sync.pendingGeneration.reason === "cloud-changed" ? "Replace cloud files" : "Apply now"}</button>}</>}
            </p>
          )}
```

Import `ago` and `ProjectDetail` from `./api`. `api` here is the `useApi()` value already used in this component (check the component's top; it is `const api = useApi();`).

- [ ] **Step 3: Mobile types, Brief, and Create**

In `apps/mobile/src/api/client.ts` add after `ProjectFile`:

```ts
export type ProjectSyncStatus = { projectId: string; lastSyncedAt?: string; appliedAt?: string; appliedManifest?: string; pendingGeneration?: { id: string; capturedAt: string; receivedAt: string; reason: "session-running" | "cloud-changed" } };
export type ProjectDetail = { id: string; name: string; sync: ProjectSyncStatus };
export function ago(iso?: string, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
}
```

In `Brief.tsx`, above the `{session.execution ? (` block add:

```tsx
            <Text style={s.small}>Tools run on {session.executionLocation === "laptop" ? "your laptop" : me?.machine?.label || connection.label || "this machine"}</Text>
```

In `Create.tsx`, after `const selectedProject = ...` add:

```tsx
  const { data: detail } = usePoll(() => selectedProject ? api<ProjectDetail>(connection, `/projects/${selectedProject}`) : Promise.resolve(null), 5000, [connection, selectedProject]);
  const [applying, setApplying] = useState(false);
  async function applyPending(force: boolean) {
    if (!selectedProject || applying) return;
    setApplying(true);
    try { await api(connection, `/projects/${selectedProject}/sync/apply`, { body: force ? { force } : {} }); refresh(); }
    catch (error) { creations.fail(machine, "sync", (error as Error).message); }
    finally { setApplying(false); }
  }
```

and after the project `<View style={s.choices}>` add:

```tsx
      {detail ? <Text style={s.note}>Synced from laptop {ago(detail.sync.lastSyncedAt)} · applied {ago(detail.sync.appliedAt)}{detail.sync.pendingGeneration ? ` · pending: ${detail.sync.pendingGeneration.reason === "session-running" ? "a session is running" : "cloud files changed"}` : ""}</Text> : null}
      {detail?.sync.pendingGeneration && me?.role === "owner" ? <Button title={applying ? "Applying…" : detail.sync.pendingGeneration.reason === "cloud-changed" ? "Replace cloud files" : "Apply now"} secondary disabled={applying || !online} onPress={() => void applyPending(detail.sync.pendingGeneration!.reason === "cloud-changed")} /> : null}
```

Import `ago` and `ProjectDetail` from `../../api/client`. If `creations.fail` requires a request id that exists, replace the `catch` with a local `setSyncError` state rendered as a warning `<Text>`.

- [ ] **Step 4: Typecheck, lint, build**

Run: `npm run typecheck && npm run build -w @infinite/web && npm run lint -w @infinite/mobile && (cd apps/mobile && npx tsc --noEmit)`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/main.tsx apps/mobile/src/api/client.ts apps/mobile/src/features/session/Brief.tsx apps/mobile/src/features/create/Create.tsx
git commit -m "Show execution location and laptop sync state on web and phone"
```

---

### Task 7: Documentation for the cloud default and workspace sync

**Files:**
- Modify: `PRODUCT.md:19-22`, `docs/architecture.md:7-9`, `docs/cli.md:1-47`, `docs/hybrid-execution.md:1-5`, `docs/security.md` (Required on a real host)
- Create: `docs/workspace-sync.md`
- Modify: `docs/superpowers/specs/2026-10-16-cloud-first-execution-design.md` (two amendments)

- [ ] **Step 1: PRODUCT.md Operating Context**

Replace the first paragraph of "Operating Context" (the one beginning "Conversations remain on a persistent cloud backend. The selected hybrid direction") with:

```
Conversations and tools run on the selected cloud machine. The Mac and the phone are connectors: they attach to cloud sessions, edit prompts locally, and move context into the cloud. A detached laptop service keeps the configured cloud project current with the owner's checkout, one way; a received generation is applied when no session runs in that project and the cloud tree is unchanged, otherwise it waits for an explicit owner apply. Laptop execution with background cloud handoff remains available for Codex as the explicit `--laptop` mode; see [hybrid execution and cloud handoff](docs/hybrid-execution.md). Nothing in this direction changes `claude`, `codex`, `grok`, or `opencode` run directly on the Mac. See [workspace sync](docs/workspace-sync.md).
```

In the last paragraph of "Open Decisions", replace `Codex now defaults to laptop execution with background project preparation and automatic checkpoint handoff on qualified backends.` with `Cloud execution is the default for every provider as of 2026-10-16; Codex laptop execution with automatic checkpoint handoff is the explicit --laptop mode on qualified backends.`

- [ ] **Step 2: docs/architecture.md Execution model**

Replace the first paragraph under "## Execution model" with:

```
Every provider runs on the selected machine by default; `Session.executionLocation` records `cloud` or `laptop`. Codex accepts `--laptop`, which keeps the invoking laptop project as the executor while its conversation backend stays in the cloud, with background preparation and automatic handoff as described in [hybrid execution](hybrid-execution.md). The configured cloud project directory is kept current by the one-way [workspace sync](workspace-sync.md) service. Reconnecting keeps the same conversation and placement.
```

Add to the API capabilities table:

```
| Project detail and sync state | `GET /api/projects/:id` | Any |
| Receive a laptop generation | `POST /api/projects/:id/sync/{begin,has,commit}`, `PUT /api/projects/:id/sync/blob/:hash` | Owner CLI |
| Apply a pending generation | `POST /api/projects/:id/sync/apply` | Owner |
| Export the cloud tree | `POST /api/projects/:id/sync/export`, `GET /api/projects/:id/sync/blob/:hash` | Owner CLI |
```

- [ ] **Step 3: docs/cli.md**

Replace the second paragraph ("The laptop CLI keeps provider conversations on the cloud host. Codex uses the current laptop project by default...") with:

```
The laptop CLI keeps provider conversations and tools on the cloud host. `infinite sync` keeps the configured cloud project current with this checkout, one way. Codex can instead run tools in the current laptop project with `--laptop`, which prepares automatic cloud handoff in the background. Detaching or losing the interface leaves the cloud conversation running.
```

Rename the section "## Laptop execution and automatic handoff" to "## Laptop execution with `--laptop`" and change its first code block to:

```sh
infinite --laptop codex "Inspect this repository"
infinite --laptop --include ../shared codex "Update this project and its shared library"
infinite --laptop --detach codex "Run the checks"
infinite resume SESSION_ID
```

Replace `Automatic handoff is enabled by default.` with `Automatic handoff is part of --laptop mode.` and replace `infinite --cloud codex opts out of laptop execution and synchronization; --laptop remains a compatibility alias.` with `--cloud is accepted and has no effect; cloud execution is the default.`

Add a new section before "## Experimental local Codex interface":

```
## Workspace sync and pull

```sh
infinite sync --project PROJECT_ID     # from inside the checkout; the Git root is synced
infinite sync --status
infinite sync --apply [--force] --project PROJECT_ID
infinite sync --stop --project PROJECT_ID
infinite pull PROJECT_ID --output NEW_DIRECTORY
```

`sync` starts a detached service that uploads the Git root of the current directory to the configured cloud project and keeps uploading changes every few seconds. The whole scope travels, including ignored and untracked files; the home directory and filesystem root are refused, and `--include` is not available (use `--laptop` for multi-root laptop execution). A received generation is applied on the host when no session runs in that project and the cloud tree matches the last applied generation. Otherwise it stays pending with a reason, shown by `infinite projects`, web, and phone. `--apply` applies a pending generation; `--force` replaces a cloud tree that changed since the last apply, keeping one previous copy beside the project as `.NAME.infinite-previous`.

`pull` downloads the current cloud project tree into a new directory and prints its path. It never writes into the checkout. Compare and merge by hand. Details: [workspace sync](workspace-sync.md).
```

- [ ] **Step 4: docs/hybrid-execution.md intro and new docs/workspace-sync.md**

In `docs/hybrid-execution.md`, change the first sentence under "## Default flow" from `` `infinite codex` uses the invoking laptop project by default. `--cloud` opts out and uses the configured cloud project. `` to `` `infinite --laptop codex` uses the invoking laptop project. Without `--laptop`, Codex runs on the cloud project like every other provider; see [workspace sync](workspace-sync.md) for how that project is kept current. ``

Create `docs/workspace-sync.md`:

```
# Workspace sync

Workspace sync keeps a configured cloud project directory current with the owner's laptop checkout. It is one way, laptop to cloud. The cloud directory is the executing copy for every session created in that project. Cloud changes travel back only through `infinite pull`, into a new directory.

## Laptop side

`infinite sync --project ID`, run inside a checkout, starts a detached service for the Git root of the current directory. The service captures the tree with the same scanner the `--laptop` mode uses: bounded SHA-256 chunks, stable reads, metadata verification, and a periodic full read. It uploads missing chunks with `PUT /api/projects/:id/sync/blob/:hash`, then commits the manifest. It records its pid, root, and last commit beside the private client configuration under `sync/`. Closing the terminal leaves it running; `infinite sync --stop` ends it. It watches nothing outside the configured project, and it does not run unless the owner started it.

## Host side

The host stores received chunks and the newest manifest per project under its private state directory. A committed manifest is **applied** when no cloud session is running or starting in that project and the live cloud tree equals the last applied generation, ignoring the Infinite-owned `.infinite/` directory. Applying materializes the tree in a sibling stage directory, moves the current directory to `.NAME.infinite-previous` (replacing the older copy), and renames the stage into place. The `.infinite/` directory is carried across.

A manifest that cannot be applied stays **pending** with a reason:

| Reason | Meaning | What clears it |
| --- | --- | --- |
| `session-running` | A cloud session runs in this project | Session exits, then `infinite sync --apply` or the next commit |
| `cloud-changed` | The cloud tree differs from the last applied generation, or the directory was non-empty on first sync | `infinite pull` to save the cloud copy, then `--apply --force` |

`GET /api/projects/:id` returns `lastSyncedAt`, `appliedAt`, `appliedManifest`, and `pendingGeneration`. Web and phone show them on the create screen with an Apply control for owners.

## Limits

One root per project. `--include` belongs to `--laptop` execution. No merge: a forced apply replaces the cloud tree. No two-way sync. Process memory, databases in use, and files outside the Git root are not covered. The single-tenant trust boundary applies: everything in the checkout, including any credentials stored there, travels to the host.
```

- [ ] **Step 5: docs/security.md and spec amendments**

In `docs/security.md` "Required on a real host", after the paragraph beginning "Authenticate providers on the server", add:

```
Workspace sync uploads the entire Git root of the selected checkout, including ignored and untracked files. Keep credentials out of synced checkouts or accept that they reach the host. A forced apply replaces the cloud tree; one previous copy is kept beside the project directory.
```

In the spec, under "## Workspace sync", change `Scope rules are unchanged from docs/hybrid-execution.md: Git decides the project root, --include adds directories, ...` to `Scope rules follow docs/hybrid-execution.md with one restriction: project sync has one root, the Git root of the launch directory; --include belongs to --laptop execution.` Change `Cloud changes return to the Mac through infinite recover SESSION_ID --output DIRECTORY, which is unchanged.` to `Cloud changes return to the Mac through infinite pull PROJECT_ID --output DIRECTORY, a project-level export. infinite recover stays for --laptop sessions.`

- [ ] **Step 6: Private-information scan and commit**

Run: `git add -A docs PRODUCT.md && git diff --cached | grep -n -I -E '/Users/|/home/[a-z0-9_-]+/|~/(Library|Projects|Documents|Desktop)|\.ts\.net|SHA256:|BEGIN [A-Z ]*PRIVATE KEY|([0-9]{1,3}\.){3}[0-9]{1,3}'`
Expected: only documentation loopback addresses, if any.

```bash
git commit -m "Document cloud-default execution and workspace sync"
```

---

### Task 8: Full check

- [ ] **Step 1: Run everything**

Run: `npm run check && npm run lint -w @infinite/mobile && (cd apps/mobile && npx tsc --noEmit)`
Expected: clean. Fix anything that fails in the task that owns it and amend that task's commit message style (one commit per fix is fine).

- [ ] **Step 2: Confirm the dirty tree is untouched**

Run: `git status --short | grep -v '^A\|^M.*docs/\|^??' | head`
Expected: the pre-existing uncommitted changes on this branch are still present and unmodified except the files this plan names.
