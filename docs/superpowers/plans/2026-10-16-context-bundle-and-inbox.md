# Context bundle and drop inbox — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cloud session starts with the secrets and configuration the owner declared for its project, and anyone steering a session can drop a file into it from web, phone, or the CLI, with the agent told where it landed.

**Architecture:** The laptop CLI reads a per-project bundle declaration from the private client configuration, collects the named env files, files, and directories into one payload, and uploads it to the host, which seals it at rest. The manager materializes the bundle into the session's environment and home before the worker spawns, and cleans up items a newer declaration dropped. A new host module `inbox.ts` accepts chunked, resumable uploads into a per-session inbox directory and asks the worker to journal a `host` notice naming the path. Chat renders that notice. Web drag and drop, a phone file picker, and `infinite push` all use the same four inbox routes.

**Tech Stack:** TypeScript on Node.js 22, Express, zod, `node:test` via `tsx`, React web client, Expo mobile client (`expo-document-picker`, `expo-file-system`).

**Spec:** `docs/superpowers/specs/2026-10-16-cloud-first-execution-design.md` (sections "Context bundle", "Drop inbox", "Browser logins", "API summary", "Security").

**Depends on:** Plan `2026-10-16-cloud-default-and-workspace-sync.md` Task 2 (`.infinite/` carried across apply) and Task 1 (`executionLocation`). Run that plan first.

## Global Constraints

- Node.js 22.14+ and npm. `npm run check` before declaring host work complete; `npm run lint -w @infinite/mobile` and `npx tsc --noEmit` in `apps/mobile` for phone changes.
- No private paths, hostnames, or secrets in tracked files; tests use `/tmp/inf-*` temp directories.
- Only declared items are read. Nothing outside the declaration is touched on the Mac. No client route ever returns a bundle value.
- Inbox: nothing is overwritten; 256 MiB per file on the host; one chunk size for every transport.
- Bundle values on the host are readable by any agent in that project. This is the accepted single-tenant trust model.
- Only Infinite-launched sessions receive bundles; plain `claude`/`codex`/`grok`/`opencode` on the Mac are unaffected.
- Commit messages: no `Claude-Session:` trailers.

## Scope decisions recorded here

- **One chunk size.** Inbox chunks are 64 KiB for direct and relay transports, sent as `{ base64 }` JSON so both paths share one route and fit the relay's 96 KiB request limit. Clients send up to four chunks concurrently. The spec's "4 MiB direct" sentence is amended by Task 8.
- **Bundle transport.** The client uploads over the authenticated TLS connection; the host seals the payload with its vault key at rest. The client does not hold the vault key. The spec's "encrypts the bundle to the host's vault key" sentence is amended by Task 8.
- **Inbox signal shape.** The worker journals a `notice` signal with `type: "inbox-file"`, `message` = project-relative path, `detail` = sha256, instead of a new signal kind. The attention reducer already ignores unknown notice types. Amended by Task 8.
- **Agent home.** `~/` targets resolve against `config.bundle?.home` when set, otherwise the API process home. Deployments that run agents under a separate account set it explicitly.
- **Phone picker, not share sheet.** The phone adds files through the system document picker. Receiving shares from other apps needs a native config plugin and is a follow-up; the spec's "share sheet" is amended by Task 8.

## Review Focus

1. **A bundle that references a path outside home or the project must be refused before any read.** `from: "../../etc/passwd"` and a symlink inside a `dir` item that points outside are refused with the path named. Test in Task 3.
2. **Removing an item from the declaration must remove its materialized file on the next launch, and must never remove a file the bundle did not write.** Test in Task 4.
3. **Inbox name collision must suffix, never overwrite.** Two uploads named `report.pdf` produce `report.pdf` and `report-<hash>.pdf`. Test in Task 2.
4. **Inbox hash mismatch must leave nothing in the inbox directory.** A complete whose bytes do not hash to the declared sha256 returns 409 and the partial file is removed. Test in Task 2.
5. **Env keys cannot shadow Infinite's own variables.** A bundle env named `INFINITE_HOOK_TOKEN` is dropped with a journaled notice. Test in Task 4.

---

### Task 1: Worker `note` op and host notices in Chat

**Files:**
- Modify: `packages/host/src/types.ts:118-160` (`WorkerRequest` union)
- Modify: `packages/host/src/worker.ts:800-830` (request dispatch)
- Modify: `packages/host/src/session-content.ts:20-41` (`recordedMessages`)
- Test: `tests/host-notice.test.ts` (new)

**Interfaces:**
- Produces: `WorkerRequest` member `{ op: "note"; type: string; message?: string; detail?: string }` → worker records `{ kind: "notice", type, message, detail }` with `source: "host"` and returns `{ seq }`. `recordedMessages` emits for `notice` signals with `type` in `["inbox-file", "delegate-denied"]` a message `{ id: "notice:<seq>", role: "tool", toolName: "Infinite", text }`.

- [ ] **Step 1: Write the failing test**

Create `tests/host-notice.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workerCall } from "../packages/host/src/ipc.js";
import { startHost, waitFor } from "./helpers.js";

test("a host note is journaled as a host notice and shown in Chat", { timeout: 30000 }, async () => {
  const host = await startHost();
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Notes", prompt: "" });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "running");
    const result = await workerCall<{ seq: number }>(host.config.runDir, id, { op: "note", type: "inbox-file", message: ".infinite/inbox/report.pdf", detail: "a".repeat(64) });
    assert.ok(result.seq > 0);
    const signals = (await host.fetchApi(`/sessions/${id}/events?types=signal`)).body.events as { data: { kind: string; type?: string; source: string; message?: string } }[];
    const notice = signals.find(e => e.data.kind === "notice" && e.data.type === "inbox-file");
    assert.ok(notice); assert.equal(notice!.data.source, "host"); assert.equal(notice!.data.message, ".infinite/inbox/report.pdf");
    const messages = (await host.fetchApi(`/sessions/${id}/messages`)).body.messages as { role: string; toolName?: string; text: string }[];
    const shown = messages.find(m => m.toolName === "Infinite");
    assert.ok(shown); assert.match(shown!.text, /report\.pdf/);
    await assert.rejects(workerCall(host.config.runDir, id, { op: "note", type: "x".repeat(80) } as never), /Invalid note/);
  } finally { await host.stop(); }
});
```

- [ ] **Step 2: Run it**

Run: `npx tsx --test tests/host-notice.test.ts`
Expected: FAIL (worker answers with an error for the unknown op).

- [ ] **Step 3: Implement**

In `packages/host/src/types.ts` add to `WorkerRequest`:

```ts
  | { op: "note"; type: string; message?: string; detail?: string }
```

In `packages/host/src/worker.ts` request dispatch, before `} else if (request.op === "native-connect") {` add:

```ts
      } else if (request.op === "note") {
        if (typeof request.type !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(request.type) ||
            (request.message !== undefined && (typeof request.message !== "string" || request.message.length > 4096)) ||
            (request.detail !== undefined && (typeof request.detail !== "string" || request.detail.length > 4096)))
          throw new Error("Invalid note");
        const event = record({ kind: "notice", type: request.type, message: request.message, detail: request.detail }, "host");
        result = { seq: event.seq };
```

In `packages/host/src/session-content.ts` `recordedMessages`, after the `tool-start` branch add:

```ts
    } else if (event.type === "signal" && data.kind === "notice" && data.source === "host" && typeof data.type === "string" && HOST_NOTICES[data.type]) {
      messages.push({ id: `notice:${event.seq}`, role: "tool", toolName: "Infinite", text: HOST_NOTICES[data.type](data), ts: event.at });
```

and above the function:

```ts
const HOST_NOTICES: Record<string, (data: Record<string, unknown>) => string> = {
  "inbox-file": data => `Added ${String(data.message ?? "a file")} to this session's inbox${typeof data.detail === "string" ? ` (sha256 ${data.detail.slice(0, 12)}…)` : ""}.`,
  "delegate-denied": data => `Delegate action refused by policy${typeof data.message === "string" ? `: ${data.message}` : ""}.`,
};
```

- [ ] **Step 4: Run and commit**

Run: `npx tsx --test tests/host-notice.test.ts`
Expected: PASS.

```bash
git add packages/host/src/types.ts packages/host/src/worker.ts packages/host/src/session-content.ts tests/host-notice.test.ts
git commit -m "Let the host journal notices into a session and show them in Chat"
```

---

### Task 2: Inbox uploads module and routes

**Files:**
- Create: `packages/host/src/inbox.ts`
- Modify: `packages/host/src/server.ts` (routes; cmux middleware refusal; error handler; relay allowlist in `packages/host/src/remote-access.ts`)
- Test: `tests/inbox.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 `note` op.
- Produces:

```ts
export const INBOX_CHUNK_BYTES = 64 * 1024;
export const INBOX_MAX_BYTES = 256 * 1024 * 1024;
export interface InboxBegin { uploadId: string; chunkBytes: number; chunks: number; received: number[] }
export interface InboxReceipt { path: string; bytes: number; sha256: string; receivedAt: string; notified: boolean }
export class InboxError extends Error { constructor(message: string, readonly code: "invalid-upload" | "unknown-upload" | "incomplete" | "hash-mismatch" | "too-large" | "backend-unsupported" | "session-not-running", readonly status = 409) }
export class InboxUploads {
  constructor(stateDir: string);
  begin(session: { id: string; cwd: string }, file: { name: string; size: number; sha256: string }): InboxBegin;
  chunk(uploadId: string, index: number, bytes: Buffer): { received: number[] };
  progress(uploadId: string): InboxBegin;
  complete(uploadId: string): Promise<Omit<InboxReceipt, "notified">>;
}
```

Routes (owner, controller):

| Method | Path | Body → Result |
| --- | --- | --- |
| POST | `/api/sessions/:id/inbox` | `{ name, size, sha256 }` → 201 `InboxBegin` |
| PUT | `/api/sessions/:id/inbox/:uploadId/chunks/:index` | `{ base64 }` → `{ received }` |
| GET | `/api/sessions/:id/inbox/:uploadId` | → `InboxBegin` |
| POST | `/api/sessions/:id/inbox/:uploadId/complete` | `{}` → `InboxReceipt` |

Files land in `<session.cwd>/.infinite/inbox/<name>`; collision appends `-<first 8 hex of sha256>` before the extension. Partials live in `stateDir/sessions/<id>/inbox-uploads/<uploadId>.part` with a `.json` sidecar, so an API restart keeps progress.

- [ ] **Step 1: Write the failing test**

Create `tests/inbox.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startHost, waitFor } from "./helpers.js";
import { INBOX_CHUNK_BYTES } from "../packages/host/src/inbox.js";

async function upload(host: Awaited<ReturnType<typeof startHost>>, id: string, name: string, bytes: Buffer, role: "owner" | "controller" = "owner", corruptHash = false) {
  const sha256 = corruptHash ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex");
  const begin = await host.fetchApi(`/sessions/${id}/inbox`, role, { name, size: bytes.length, sha256 });
  if (begin.status !== 201) return begin;
  const { uploadId, chunkBytes } = begin.body;
  for (let index = 0; index * chunkBytes < bytes.length; index++) {
    const put = await host.fetchApi(`/sessions/${id}/inbox/${uploadId}/chunks/${index}`, role, { base64: bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64") }, {}, "PUT");
    assert.equal(put.status, 200, JSON.stringify(put.body));
  }
  return host.fetchApi(`/sessions/${id}/inbox/${uploadId}/complete`, role, {});
}

test("inbox uploads land in .infinite/inbox, never overwrite, verify hashes, and notify the agent", { timeout: 60000 }, async () => {
  const host = await startHost();
  try {
    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Inbox", prompt: "" });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "running");
    const cwd = host.config.projects[0].path;
    const small = Buffer.from("hello inbox\n");
    const first = await upload(host, id, "report.pdf", small);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.path, ".infinite/inbox/report.pdf");
    assert.equal(first.body.bytes, small.length);
    assert.equal(first.body.notified, true);
    assert.equal(readFileSync(join(cwd, first.body.path), "utf8"), "hello inbox\n");

    const big = randomBytes(INBOX_CHUNK_BYTES * 2 + 17);
    const second = await upload(host, id, "report.pdf", big, "controller");
    assert.equal(second.status, 200);
    assert.match(second.body.path, /^\.infinite\/inbox\/report-[a-f0-9]{8}\.pdf$/);
    assert.ok(Buffer.from(readFileSync(join(cwd, second.body.path))).equals(big));
    assert.equal(readFileSync(join(cwd, ".infinite/inbox/report.pdf"), "utf8"), "hello inbox\n", "the first file is untouched");

    const bad = await upload(host, id, "broken.bin", Buffer.from("x"), "owner", true);
    assert.equal(bad.status, 409); assert.equal(bad.body.code, "hash-mismatch");
    assert.deepEqual(readdirSync(join(cwd, ".infinite/inbox")).filter(n => n.startsWith("broken")), []);

    assert.equal((await host.fetchApi(`/sessions/${id}/inbox`, "viewer", { name: "x", size: 1, sha256: "a".repeat(64) })).status, 403);
    assert.equal((await host.fetchApi(`/sessions/${id}/inbox`, "owner", { name: "../escape", size: 1, sha256: "a".repeat(64) })).status, 400);
    assert.equal((await host.fetchApi(`/sessions/${id}/inbox`, "owner", { name: "huge.bin", size: 256 * 1024 * 1024 + 1, sha256: "a".repeat(64) })).status, 413);

    const messages = (await host.fetchApi(`/sessions/${id}/messages`)).body.messages as { toolName?: string; text: string }[];
    assert.equal(messages.filter(m => m.toolName === "Infinite").length, 2);

    // Progress survives an API restart; an unfinished upload resumes with the same id.
    const partial = randomBytes(INBOX_CHUNK_BYTES * 3);
    const begin = await host.fetchApi(`/sessions/${id}/inbox`, "owner", { name: "resume.bin", size: partial.length, sha256: createHash("sha256").update(partial).digest("hex") });
    await host.fetchApi(`/sessions/${id}/inbox/${begin.body.uploadId}/chunks/0`, "owner", { base64: partial.subarray(0, INBOX_CHUNK_BYTES).toString("base64") }, {}, "PUT");
    await host.stopApi(); await host.start();
    const progress = await host.fetchApi(`/sessions/${id}/inbox/${begin.body.uploadId}`);
    assert.deepEqual(progress.body.received, [0]);
    for (const index of [1, 2]) await host.fetchApi(`/sessions/${id}/inbox/${begin.body.uploadId}/chunks/${index}`, "owner", { base64: partial.subarray(index * INBOX_CHUNK_BYTES, (index + 1) * INBOX_CHUNK_BYTES).toString("base64") }, {}, "PUT");
    const done = await host.fetchApi(`/sessions/${id}/inbox/${begin.body.uploadId}/complete`, "owner", {});
    assert.equal(done.status, 200);
    assert.ok(Buffer.from(readFileSync(join(cwd, done.body.path))).equals(partial));
    assert.equal(existsSync(join(host.config.stateDir, "sessions", id, "inbox-uploads", `${begin.body.uploadId}.part`)), false);
  } finally { await host.stop(); }
});
```

`host.fetchApi` accepts `(path, role, body, headers, method)`; the `{}` fourth argument is the headers object.

- [ ] **Step 2: Run it**

Run: `npx tsx --test tests/inbox.test.ts`
Expected: FAIL with 404 on `/inbox`.

- [ ] **Step 3: Implement `inbox.ts`**

Create `packages/host/src/inbox.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { open, realpath, rename, rm, mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export const INBOX_CHUNK_BYTES = 64 * 1024;
export const INBOX_MAX_BYTES = 256 * 1024 * 1024;
export interface InboxBegin { uploadId: string; chunkBytes: number; chunks: number; received: number[] }
export interface InboxReceipt { path: string; bytes: number; sha256: string; receivedAt: string; notified: boolean }
type Upload = { uploadId: string; sessionId: string; cwd: string; name: string; size: number; sha256: string; received: number[] };

export class InboxError extends Error {
  constructor(message: string, readonly code: "invalid-upload" | "unknown-upload" | "incomplete" | "hash-mismatch" | "too-large" | "backend-unsupported" | "session-not-running", readonly status = 409) {
    super(message);
  }
}

const NAME = /^[^\x00-\x1f\x7f/\\]{1,255}$/;
export function sanitizeInboxName(name: string): string {
  const clean = basename(name.normalize("NFC")).trim();
  if (!NAME.test(clean) || clean === "." || clean === ".." || clean.startsWith(".")) throw new InboxError("Choose a plain file name", "invalid-upload", 400);
  return clean;
}

/** Chunked, resumable uploads into a session's `.infinite/inbox/` directory. Nothing is overwritten. */
export class InboxUploads {
  private readonly uploads = new Map<string, Upload>();
  constructor(private readonly stateDir: string) {}

  private dir(sessionId: string) {
    const dir = join(this.stateDir, "sessions", sessionId, "inbox-uploads");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  private save(upload: Upload) {
    const file = join(this.dir(upload.sessionId), `${upload.uploadId}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(upload), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  }
  private load(uploadId: string): Upload {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new InboxError("Unknown upload", "unknown-upload", 404);
    const cached = this.uploads.get(uploadId);
    if (cached) return cached;
    const sessions = join(this.stateDir, "sessions");
    for (const sessionId of existsSync(sessions) ? readdirSync(sessions) : []) {
      const file = join(sessions, sessionId, "inbox-uploads", `${uploadId}.json`);
      if (existsSync(file)) { const upload = JSON.parse(readFileSync(file, "utf8")) as Upload; this.uploads.set(uploadId, upload); return upload; }
    }
    throw new InboxError("Unknown upload", "unknown-upload", 404);
  }
  private view(upload: Upload): InboxBegin {
    return { uploadId: upload.uploadId, chunkBytes: INBOX_CHUNK_BYTES, chunks: Math.max(1, Math.ceil(upload.size / INBOX_CHUNK_BYTES)), received: [...upload.received].sort((a, b) => a - b) };
  }

  begin(session: { id: string; cwd: string }, file: { name: string; size: number; sha256: string }): InboxBegin {
    const name = sanitizeInboxName(file.name);
    if (!Number.isInteger(file.size) || file.size < 0) throw new InboxError("Invalid file size", "invalid-upload", 400);
    if (file.size > INBOX_MAX_BYTES) throw new InboxError("Files above 256 MiB are not accepted", "too-large", 413);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new InboxError("Invalid sha256", "invalid-upload", 400);
    const upload: Upload = { uploadId: randomUUID(), sessionId: session.id, cwd: session.cwd, name, size: file.size, sha256: file.sha256, received: [] };
    const fd = openSync(join(this.dir(session.id), `${upload.uploadId}.part`), "wx", 0o600);
    closeSync(fd);
    this.uploads.set(upload.uploadId, upload);
    this.save(upload);
    return this.view(upload);
  }
  chunk(uploadId: string, index: number, bytes: Buffer): { received: number[] } {
    const upload = this.load(uploadId);
    const chunks = Math.max(1, Math.ceil(upload.size / INBOX_CHUNK_BYTES));
    if (!Number.isInteger(index) || index < 0 || index >= chunks) throw new InboxError("Chunk index is out of range", "invalid-upload", 400);
    const expected = index === chunks - 1 ? upload.size - index * INBOX_CHUNK_BYTES : INBOX_CHUNK_BYTES;
    if (bytes.length !== expected) throw new InboxError("Chunk length does not match the declared size", "invalid-upload", 400);
    const fd = openSync(join(this.dir(upload.sessionId), `${uploadId}.part`), "r+");
    try { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, index * INBOX_CHUNK_BYTES + offset); }
    finally { closeSync(fd); }
    if (!upload.received.includes(index)) { upload.received.push(index); this.save(upload); }
    return { received: this.view(upload).received };
  }
  progress(uploadId: string): InboxBegin { return this.view(this.load(uploadId)); }

  async complete(uploadId: string): Promise<Omit<InboxReceipt, "notified">> {
    const upload = this.load(uploadId);
    const view = this.view(upload);
    if (view.received.length !== view.chunks && upload.size > 0) throw new InboxError("Upload is incomplete", "incomplete");
    const part = join(this.dir(upload.sessionId), `${uploadId}.part`);
    const hash = createHash("sha256");
    const handle = await open(part, "r");
    let total = 0;
    try { for await (const block of handle.createReadStream({ autoClose: false })) { hash.update(block as Buffer); total += (block as Buffer).length; } }
    finally { await handle.close(); }
    const digest = hash.digest("hex");
    if (total !== upload.size || digest !== upload.sha256) {
      await rm(part, { force: true }); rmSync(join(this.dir(upload.sessionId), `${uploadId}.json`), { force: true }); this.uploads.delete(uploadId);
      throw new InboxError("Uploaded bytes do not match the declared sha256", "hash-mismatch");
    }
    const root = await realpath(upload.cwd);
    const inbox = join(root, ".infinite", "inbox");
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    const ext = extname(upload.name), stem = upload.name.slice(0, upload.name.length - ext.length);
    let name = upload.name;
    if (existsSync(join(inbox, name))) name = `${stem}-${digest.slice(0, 8)}${ext}`;
    if (existsSync(join(inbox, name))) name = `${stem}-${digest.slice(0, 8)}-${randomUUID().slice(0, 8)}${ext}`;
    await rename(part, join(inbox, name));
    rmSync(join(this.dir(upload.sessionId), `${uploadId}.json`), { force: true });
    this.uploads.delete(uploadId);
    return { path: `.infinite/inbox/${name}`, bytes: total, sha256: digest, receivedAt: new Date().toISOString() };
  }
}
```

`rename` from the state directory into the project may cross filesystems (EXDEV). Handle it: wrap `await rename(part, target)` in try/catch; on `EXDEV`, copy with `copyFile` to a temp name inside `inbox` then `rename`, then `rm(part)`. Import `copyFile` from `node:fs/promises`.

- [ ] **Step 4: Routes and refusals**

In `packages/host/src/server.ts`:

- Import: `import { InboxUploads, InboxError } from "./inbox.js";` and create `const inbox = new InboxUploads(config.stateDir);` after `projectSync`.
- In the cmux middleware (`app.use("/api/sessions/:id", ...)`), right after `const action = req.path;` add:

```ts
    if (action === "/inbox" || action.startsWith("/inbox/")) return void res.status(409).json({ error: "Inbox uploads need an Infinite-owned workspace", code: "backend-unsupported" });
```

- Add routes before `app.get("/api/sessions/:id/events", ...)`:

```ts
  const inboxSession = async (sessionId: string) => {
    const session = manager.meta(sessionId).session;
    const state = await manager.state(sessionId);
    if (!["running", "starting"].includes(state.status)) throw new InboxError("This session is not running", "session-not-running");
    if (session.workspace) throw new InboxError("Laptop-executed sessions keep their files on the laptop", "backend-unsupported");
    return session;
  };
  app.post("/api/sessions/:id/inbox", requireRole(["owner", "controller"]), async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const session = await inboxSession(sessionId);
    const body = z.object({ name: z.string().min(1).max(255), size: z.number().int().min(0), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    res.status(201).json(inbox.begin({ id: session.id, cwd: session.cwd }, body));
  });
  app.get("/api/sessions/:id/inbox/:uploadId", requireRole(["owner", "controller"]), (req, res) => {
    manager.meta(id.parse(req.params.id));
    res.json(inbox.progress(String(req.params.uploadId)));
  });
  app.put("/api/sessions/:id/inbox/:uploadId/chunks/:index", requireRole(["owner", "controller"]), (req, res) => {
    manager.meta(id.parse(req.params.id));
    const body = z.object({ base64: z.string().min(1).max(INBOX_CHUNK_BYTES * 2) }).strict().parse(req.body);
    const index = z.coerce.number().int().min(0).max(1 << 20).parse(req.params.index);
    res.json(inbox.chunk(String(req.params.uploadId), index, Buffer.from(body.base64, "base64")));
  });
  app.post("/api/sessions/:id/inbox/:uploadId/complete", requireRole(["owner", "controller"]), async (req, res) => {
    const sessionId = id.parse(req.params.id);
    await inboxSession(sessionId);
    const receipt = await inbox.complete(String(req.params.uploadId));
    let notified = false;
    try { await workerCall(config.runDir, sessionId, { op: "note", type: "inbox-file", message: receipt.path, detail: receipt.sha256 }); notified = true; } catch { /* the file is in place; the agent was not told */ }
    res.json({ ...receipt, notified });
  });
```

Import `INBOX_CHUNK_BYTES` from `./inbox.js`. In the error handler add `if (error instanceof InboxError) return res.status(error.status).json({ code: error.code, error: error.message });`.

- In `packages/host/src/remote-access.ts` `allowedPath`, before the `match` line add:

```ts
  const inbox = /^\/api\/sessions\/([^/]+)\/inbox(?:\/([0-9a-f-]{36})(?:\/(chunks\/\d{1,7}|complete))?)?$/.exec(url.pathname);
  if (inbox && UUID.test(inbox[1])) {
    if (!inbox[2]) return method === "POST";
    if (!inbox[3]) return method === "GET";
    return inbox[3] === "complete" ? method === "POST" : method === "PUT";
  }
```

- [ ] **Step 5: Run and commit**

Run: `npx tsx --test tests/inbox.test.ts tests/remote-access.test.ts tests/cmux.test.ts`
Expected: PASS.

```bash
git add packages/host/src/inbox.ts packages/host/src/server.ts packages/host/src/remote-access.ts tests/inbox.test.ts
git commit -m "Accept chunked inbox uploads into a session workspace"
```

---

### Task 3: Bundle declaration and collection on the laptop

**Files:**
- Create: `packages/host/src/bundle-client.ts`
- Test: `tests/bundle-client.test.ts` (new)

**Interfaces:**

```ts
export const bundleItemSchema: z.ZodType<BundleItemDeclaration>;
export interface BundleItemDeclaration { kind: "env" | "file" | "dir"; from: string; to?: string; mode?: string /* octal like "0600" */ }
export interface BundleDeclaration { global?: BundleItemDeclaration[]; projects?: Record<string, BundleItemDeclaration[]> }
export type BundleItem =
  | { kind: "env"; name: string; entries: Record<string, string> }
  | { kind: "file"; to: string; mode: number; bytes: number; base64: string }
  | { kind: "dir"; to: string; files: { path: string; mode: number; bytes: number; base64: string }[] };
export interface BundlePayload { version: 1; items: BundleItem[] }
export const BUNDLE_ITEM_MAX_BYTES = 16 * 1024 * 1024;
export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
export async function collectBundle(options: { declaration: BundleDeclaration; projectId: string; projectRoot: string; home: string }): Promise<BundlePayload>;
export function parseDotenv(text: string): Record<string, string>;
```

Resolution rules: `from` beginning with `~/` resolves under `home`; a relative `from` resolves under `projectRoot`; an absolute `from` must realpath inside `home` or `projectRoot`. `to` defaults to `from` when `from` was `~/...` (kept as `~/...`), otherwise to the project-relative `from`. `to` must start with `~/` or be relative without `..` segments. Symlinks encountered anywhere are refused with the path named. Items from `global` come first, then the project's.

- [ ] **Step 1: Write the failing tests**

Create `tests/bundle-client.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { collectBundle, parseDotenv, BUNDLE_ITEM_MAX_BYTES } from "../packages/host/src/bundle-client.js";

function fixture() {
  const root = realpathSync(mkdtempSync("/tmp/inf-bundle-"));
  const home = join(root, "home"), project = join(root, "home", "code", "example");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Dev\n");
  writeFileSync(join(project, ".env.local"), "API_KEY='abc'\nexport DEBUG=1\n# comment\nEMPTY=\nQUOTED=\"a b\"\n");
  mkdirSync(join(home, ".config", "example-cli"), { recursive: true });
  writeFileSync(join(home, ".config", "example-cli", "settings.json"), "{}", { mode: 0o600 });
  writeFileSync(join(home, "deploy.key"), "secret\n", { mode: 0o600 });
  return { root, home, project };
}

test("dotenv parsing keeps quoted values and ignores comments", () => {
  assert.deepEqual(parseDotenv("A=1\n# c\nexport B='x y'\nC=\"q\"\nD=\n"), { A: "1", B: "x y", C: "q", D: "" });
});

test("collects env, file, and dir items with default destinations and modes", async () => {
  const f = fixture();
  try {
    const payload = await collectBundle({ projectId: "example", projectRoot: f.project, home: f.home, declaration: {
      global: [{ kind: "file", from: "~/.gitconfig" }],
      projects: { example: [
        { kind: "env", from: ".env.local" },
        { kind: "file", from: "~/deploy.key", to: "~/.ssh/deploy_example", mode: "0600" },
        { kind: "dir", from: "~/.config/example-cli" },
      ] },
    } });
    assert.equal(payload.version, 1);
    assert.equal(payload.items.length, 4);
    assert.deepEqual(payload.items[0], { kind: "file", to: "~/.gitconfig", mode: payload.items[0].kind === "file" ? payload.items[0].mode : 0, bytes: 22, base64: Buffer.from("[user]\n\tname = Dev\n").toString("base64") });
    const env = payload.items[1]; assert.equal(env.kind, "env"); if (env.kind === "env") { assert.equal(env.name, ".env.local"); assert.deepEqual(env.entries, { API_KEY: "abc", DEBUG: "1", EMPTY: "", QUOTED: "a b" }); }
    const key = payload.items[2]; assert.equal(key.kind, "file"); if (key.kind === "file") { assert.equal(key.to, "~/.ssh/deploy_example"); assert.equal(key.mode, 0o600); }
    const dir = payload.items[3]; assert.equal(dir.kind, "dir"); if (dir.kind === "dir") { assert.equal(dir.to, "~/.config/example-cli"); assert.deepEqual(dir.files.map(x => x.path), ["settings.json"]); assert.equal(dir.files[0].mode, 0o600); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("escaping paths, symlinks, and oversized items are refused by name before any upload", async () => {
  const f = fixture();
  try {
    const collect = (items: object[]) => collectBundle({ projectId: "example", projectRoot: f.project, home: f.home, declaration: { projects: { example: items as never } } });
    await assert.rejects(collect([{ kind: "file", from: "../../../etc/hosts" }]), /etc\/hosts/);
    await assert.rejects(collect([{ kind: "file", from: "/etc/hosts" }]), /etc\/hosts/);
    await assert.rejects(collect([{ kind: "file", from: "~/.gitconfig", to: "../outside" }]), /outside/);
    await assert.rejects(collect([{ kind: "file", from: "~/.gitconfig", to: "/abs" }]), /abs/);
    symlinkSync("/etc", join(f.home, ".config", "example-cli", "link"));
    await assert.rejects(collect([{ kind: "dir", from: "~/.config/example-cli" }]), /link/);
    writeFileSync(join(f.project, "big.bin"), Buffer.alloc(BUNDLE_ITEM_MAX_BYTES + 1));
    await assert.rejects(collect([{ kind: "file", from: "big.bin" }]), /big\.bin/);
    await assert.rejects(collect([{ kind: "env", from: "missing.env" }]), /missing\.env/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
```

Fix the first `assert.deepEqual` to compare fields individually: `assert.equal(item.kind, "file"); assert.equal(item.to, "~/.gitconfig"); assert.equal(item.bytes, 22);`.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/bundle-client.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `packages/host/src/bundle-client.ts`:

```ts
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const BUNDLE_ITEM_MAX_BYTES = 16 * 1024 * 1024;
export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
export const bundleItemSchema = z.object({
  kind: z.enum(["env", "file", "dir"]),
  from: z.string().min(1).max(4096),
  to: z.string().min(1).max(4096).optional(),
  mode: z.string().regex(/^0?[0-7]{3}$/).optional(),
}).strict();
export const bundleDeclarationSchema = z.object({
  global: z.array(bundleItemSchema).max(64).optional(),
  projects: z.record(z.string().regex(/^[a-z0-9-]{1,80}$/), z.array(bundleItemSchema).max(64)).optional(),
}).strict();
export type BundleItemDeclaration = z.infer<typeof bundleItemSchema>;
export type BundleDeclaration = z.infer<typeof bundleDeclarationSchema>;
export type BundleItem =
  | { kind: "env"; name: string; entries: Record<string, string> }
  | { kind: "file"; to: string; mode: number; bytes: number; base64: string }
  | { kind: "dir"; to: string; files: { path: string; mode: number; bytes: number; base64: string }[] };
export interface BundlePayload { version: 1; items: BundleItem[] }

const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

export function parseDotenv(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
    entries[match[1]] = value;
  }
  return entries;
}

function destination(item: BundleItemDeclaration, fromDisplay: string): string {
  const to = item.to ?? fromDisplay;
  if (to.startsWith("~/")) { if (to.split("/").some(part => part === "..")) throw new Error(`Bundle destination escapes the home directory: ${to}`); return to; }
  if (isAbsolute(to) || to.split(/[\\/]/).some(part => part === "..") || to.startsWith("~")) throw new Error(`Bundle destination must be ~/... or project-relative: ${to}`);
  return posix.normalize(to);
}

async function sourcePath(from: string, roots: { home: string; projectRoot: string }): Promise<{ path: string; display: string }> {
  const candidate = from.startsWith("~/") ? join(roots.home, from.slice(2)) : isAbsolute(from) ? from : resolve(roots.projectRoot, from);
  let path: string;
  try { path = await realpath(candidate); } catch { throw new Error(`Bundle source is missing: ${from}`); }
  if (!inside(roots.home, path) && !inside(roots.projectRoot, path)) throw new Error(`Bundle source is outside the home and project directories: ${from}`);
  if (path !== resolve(candidate)) throw new Error(`Bundle source must not be a symlink: ${from}`);
  const display = inside(roots.projectRoot, path) && !from.startsWith("~/") ? relative(roots.projectRoot, path).split(sep).join("/") : `~/${relative(roots.home, path).split(sep).join("/")}`;
  return { path, display };
}

async function readBounded(path: string, display: string, budget: { used: number }) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Bundle source must not be a symlink: ${display}`);
  if (!info.isFile()) throw new Error(`Bundle source is not a regular file: ${display}`);
  if (info.size > BUNDLE_ITEM_MAX_BYTES) throw new Error(`Bundle item exceeds 16 MiB: ${display}`);
  budget.used += info.size;
  if (budget.used > BUNDLE_MAX_BYTES) throw new Error(`Bundle exceeds 64 MiB at ${display}`);
  return { bytes: await readFile(path), mode: info.mode & 0o777 };
}

/** Collect exactly the declared items. Nothing outside the declaration is read. */
export async function collectBundle(options: { declaration: BundleDeclaration; projectId: string; projectRoot: string; home: string }): Promise<BundlePayload> {
  const declaration = bundleDeclarationSchema.parse(options.declaration);
  const home = await realpath(options.home), projectRoot = await realpath(options.projectRoot);
  const items: BundleItem[] = [];
  const budget = { used: 0 };
  for (const item of [...(declaration.global ?? []), ...(declaration.projects?.[options.projectId] ?? [])]) {
    const source = await sourcePath(item.from, { home, projectRoot });
    const mode = item.mode !== undefined ? parseInt(item.mode, 8) : undefined;
    if (item.kind === "env") {
      const { bytes } = await readBounded(source.path, item.from, budget);
      items.push({ kind: "env", name: posix.basename(source.display), entries: parseDotenv(bytes.toString("utf8")) });
    } else if (item.kind === "file") {
      const read = await readBounded(source.path, item.from, budget);
      items.push({ kind: "file", to: destination(item, source.display), mode: mode ?? read.mode, bytes: read.bytes.length, base64: read.bytes.toString("base64") });
    } else {
      const to = destination(item, source.display);
      const files: Extract<BundleItem, { kind: "dir" }>["files"] = [];
      let dirBytes = 0;
      const walk = async (dir: string, prefix: string) => {
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const path = join(dir, entry.name), display = `${item.from}/${prefix}${entry.name}`;
          if (entry.isSymbolicLink()) throw new Error(`Bundle directories cannot contain symlinks: ${display}`);
          if (entry.isDirectory()) { await walk(path, `${prefix}${entry.name}/`); continue; }
          const read = await readBounded(path, display, budget);
          dirBytes += read.bytes.length;
          if (dirBytes > BUNDLE_ITEM_MAX_BYTES) throw new Error(`Bundle item exceeds 16 MiB: ${item.from}`);
          files.push({ path: `${prefix}${entry.name}`, mode: mode ?? read.mode, bytes: read.bytes.length, base64: read.bytes.toString("base64") });
        }
      };
      if (!(await lstat(source.path)).isDirectory()) throw new Error(`Bundle source is not a directory: ${item.from}`);
      await walk(source.path, "");
      items.push({ kind: "dir", to, files });
    }
  }
  return { version: 1, items };
}
```

- [ ] **Step 4: Run and commit**

Run: `npx tsx --test tests/bundle-client.test.ts`
Expected: PASS (3 tests).

```bash
git add packages/host/src/bundle-client.ts tests/bundle-client.test.ts
git commit -m "Collect declared context bundle items on the laptop"
```

---

### Task 4: Host bundle store, routes, and materialization at launch

**Files:**
- Create: `packages/host/src/bundle.ts`
- Modify: `packages/host/src/config.ts` (optional `bundle: { home?: string }`), `packages/host/src/types.ts` (`Config.bundle`, `Bootstrap.env`, `Session.bundleVersion`), `packages/host/src/manager.ts` (`createOnce`), `packages/host/src/worker.ts:940-960` (env), `packages/host/src/server.ts` (routes, json limit), `packages/host/src/remote-access.ts` (GET allowlist)
- Test: `tests/bundle.test.ts` (new)

**Interfaces:**

```ts
export interface BundleSummary { version: string; syncedAt: string; items: { kind: "env" | "file" | "dir"; name?: string; to?: string; bytes: number; files: number }[] }
export class BundleStore {
  constructor(stateDir: string, key: Buffer, home: string);
  put(projectId: string, payload: unknown): BundleSummary;          // validates, seals to stateDir/bundles/<projectId>.sealed
  get(projectId: string): BundleSummary | undefined;
  remove(projectId: string): boolean;
  /** Writes file/dir items, removes items a previous materialization wrote that are no longer declared, returns env to inject. */
  materialize(projectId: string, cwd: string, notice: (type: string, message: string) => void): { env: Record<string, string>; version?: string };
}
```

Routes: `PUT /api/projects/:id/bundle` (owner, bearer only, json limit 128 MiB) → `BundleSummary`; `GET /api/projects/:id/bundle` (owner, controller) → `BundleSummary` or 404 `{ error: "No bundle" }`; `DELETE` (owner) → `{ removed: boolean }`. Relay allowlist: GET only.

`Bootstrap.env?: Record<string, string>`; worker merges it into the spawn env after its own variables, skipping keys that start with `INFINITE_` (journaled as notice `bundle-env-skipped`). `Session.bundleVersion?: string`.

- [ ] **Step 1: Write the failing test**

Create `tests/bundle.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { startHost, waitFor } from "./helpers.js";

const base64 = (text: string) => Buffer.from(text).toString("base64");

test("bundles are stored sealed, listed without values, materialized at launch, and cleaned up when removed", { timeout: 90000 }, async () => {
  const home = realpathSync(mkdtempSync("/tmp/inf-bundle-home-"));
  const host = await startHost({
    config: { bundle: { home } },
    agents: { codex: { command: process.execPath, args: ["-e", `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[1] + '/env.json', JSON.stringify({ API_KEY: process.env.API_KEY, HOOK: process.env.INFINITE_HOOK_TOKEN }));
      setInterval(() => {}, 1000);`, "--"] } },
  });
  try {
    const cwd = host.config.projects[0].path;
    const payload = { version: 1, items: [
      { kind: "env", name: ".env.local", entries: { API_KEY: "abc", INFINITE_HOOK_TOKEN: "evil" } },
      { kind: "file", to: "~/.ssh/deploy_example", mode: 0o600, bytes: 7, base64: base64("secret\n") },
      { kind: "dir", to: ".infinite/example-cli", files: [{ path: "settings.json", mode: 0o644, bytes: 2, base64: base64("{}") }] },
    ] };
    const put = await host.fetchApi("/projects/rehearsal/bundle", "owner", payload, {}, "PUT");
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.items.length, 3);
    assert.equal(JSON.stringify(put.body).includes("abc"), false, "values never leave the host");
    const listed = await host.fetchApi("/projects/rehearsal/bundle", "controller");
    assert.equal(listed.status, 200); assert.equal(listed.body.version, put.body.version);
    assert.equal((await host.fetchApi("/projects/rehearsal/bundle", "viewer")).status, 403);
    assert.equal(statSync(join(host.config.stateDir, "bundles", "rehearsal.sealed")).mode & 0o077, 0);
    assert.equal(readFileSync(join(host.config.stateDir, "bundles", "rehearsal.sealed"), "utf8").includes("abc"), false);

    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", { requestId: id, provider: "codex", projectId: "rehearsal", title: "Bundle", prompt: "", nativeArgs: [cwd] });
    assert.equal(created.status, 201);
    assert.equal(created.body.bundleVersion, put.body.version);
    await waitFor(async () => existsSync(join(cwd, "env.json")), v => v, 15000);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, "env.json"), "utf8")).API_KEY, "abc");
    assert.notEqual(JSON.parse(readFileSync(join(cwd, "env.json"), "utf8")).HOOK, "evil", "bundle env cannot shadow Infinite variables");
    assert.equal(readFileSync(join(home, ".ssh", "deploy_example"), "utf8"), "secret\n");
    assert.equal(statSync(join(home, ".ssh", "deploy_example")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(cwd, ".infinite", "example-cli", "settings.json"), "utf8"), "{}");
    const signals = (await host.fetchApi(`/sessions/${id}/events?types=signal`)).body.events as { data: { kind: string; type?: string } }[];
    assert.ok(signals.some(e => e.data.kind === "notice" && e.data.type === "bundle-env-skipped"));

    writeFileSync(join(home, ".ssh", "mine.txt"), "not from the bundle\n");
    const smaller = { version: 1, items: [{ kind: "file", to: "~/.ssh/deploy_example", mode: 0o600, bytes: 7, base64: base64("rotate\n") }] };
    await host.fetchApi("/projects/rehearsal/bundle", "owner", smaller, {}, "PUT");
    const second = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: second, provider: "codex", projectId: "rehearsal", title: "Bundle 2", prompt: "", nativeArgs: [cwd] });
    await waitFor(() => host.fetchApi(`/sessions/${second}`), r => r.body.status === "running");
    assert.equal(readFileSync(join(home, ".ssh", "deploy_example"), "utf8"), "rotate\n");
    assert.equal(existsSync(join(cwd, ".infinite", "example-cli", "settings.json")), false, "dropped items are removed");
    assert.equal(readFileSync(join(home, ".ssh", "mine.txt"), "utf8"), "not from the bundle\n", "files the bundle never wrote are untouched");

    assert.deepEqual((await host.fetchApi("/projects/rehearsal/bundle", "owner", undefined, {}, "DELETE")).body, { removed: true });
    assert.equal((await host.fetchApi("/projects/rehearsal/bundle", "owner")).status, 404);
    assert.equal((await host.fetchApi("/projects/rehearsal/bundle", "owner", { version: 1, items: [{ kind: "file", to: "/etc/x", mode: 420, bytes: 1, base64: "eA==" }] }, {}, "PUT")).status, 400);
  } finally { await host.stop(); rmSync(home, { recursive: true, force: true }); }
});
```

The codex fixture is launched with `nativeArgs: [cwd]` so the fixture receives the cwd as `process.argv[1]` after `--`; `nativeArgs` launches keep hooks off, which is fine here.

- [ ] **Step 2: Run it**

Run: `npx tsx --test tests/bundle.test.ts`
Expected: FAIL with 404 on `/bundle` (and config refusal for `bundle` key).

- [ ] **Step 3: Config and types**

In `packages/host/src/config.ts` schema add after `push`:

```ts
    bundle: z.object({ home: z.string().refine(isAbsolute, "Bundle home must be absolute").optional() }).strict().optional(),
```

In `packages/host/src/types.ts`: add to `Config`: `bundle?: { home?: string };`; to `Session` after `executionLocation`: `bundleVersion?: string;`; to `Bootstrap`: `env?: Record<string, string>;`.

- [ ] **Step 4: Implement `bundle.ts`**

Create `packages/host/src/bundle.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, rmdirSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { unseal, writeSealed } from "./vault.js";

const file = z.object({ path: z.string().min(1).max(1024), mode: z.number().int().min(0).max(0o777), bytes: z.number().int().min(0), base64: z.string() }).strict();
const payloadSchema = z.object({
  version: z.literal(1),
  items: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("env"), name: z.string().min(1).max(255), entries: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(65536)) }).strict(),
    z.object({ kind: z.literal("file"), to: z.string().min(1).max(4096), mode: z.number().int().min(0).max(0o777), bytes: z.number().int().min(0), base64: z.string() }).strict(),
    z.object({ kind: z.literal("dir"), to: z.string().min(1).max(4096), files: z.array(file).max(4096) }).strict(),
  ])).max(128),
}).strict();
export type BundlePayload = z.infer<typeof payloadSchema>;
export interface BundleSummary { version: string; syncedAt: string; items: { kind: "env" | "file" | "dir"; name?: string; to?: string; bytes: number; files: number }[] }
type Stored = { payload: BundlePayload; version: string; syncedAt: string };

export class BundleError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

const escapes = (path: string) => path.split(/[\\/]/).some(part => part === "..");
function target(to: string, cwd: string, home: string): string {
  if (to.startsWith("~/")) { if (escapes(to)) throw new BundleError(`Bundle destination escapes the home directory: ${to}`); return join(home, to.slice(2)); }
  if (isAbsolute(to) || escapes(to) || to.startsWith("~")) throw new BundleError(`Bundle destination must be ~/... or project-relative: ${to}`);
  return join(cwd, to);
}
const within = (root: string, path: string) => { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export class BundleStore {
  constructor(private readonly stateDir: string, private readonly key: Buffer, private readonly home: string) {}
  private file(projectId: string, suffix = "sealed") { return join(this.stateDir, "bundles", `${projectId}.${suffix}`); }
  private load(projectId: string): Stored | undefined {
    const file = this.file(projectId);
    return existsSync(file) ? unseal<Stored>(this.key, `bundle:${projectId}`, readFileSync(file, "utf8")) : undefined;
  }
  private summary(stored: Stored): BundleSummary {
    return { version: stored.version, syncedAt: stored.syncedAt, items: stored.payload.items.map(item => item.kind === "env"
      ? { kind: "env", name: item.name, bytes: Object.values(item.entries).reduce((n, v) => n + Buffer.byteLength(v), 0), files: 1 }
      : item.kind === "file" ? { kind: "file", to: item.to, bytes: item.bytes, files: 1 }
      : { kind: "dir", to: item.to, bytes: item.files.reduce((n, f) => n + f.bytes, 0), files: item.files.length }) };
  }
  put(projectId: string, value: unknown): BundleSummary {
    const parsed = payloadSchema.safeParse(value);
    if (!parsed.success) throw new BundleError("Invalid bundle payload");
    for (const item of parsed.data.items) {
      if (item.kind === "file") { target(item.to, "/project", "/home"); if (Buffer.from(item.base64, "base64").length !== item.bytes) throw new BundleError(`Bundle item size mismatch: ${item.to}`); }
      if (item.kind === "dir") { target(item.to, "/project", "/home"); for (const f of item.files) { if (isAbsolute(f.path) || escapes(f.path)) throw new BundleError(`Bundle file path escapes its directory: ${f.path}`); if (Buffer.from(f.base64, "base64").length !== f.bytes) throw new BundleError(`Bundle item size mismatch: ${item.to}/${f.path}`); } }
    }
    const stored: Stored = { payload: parsed.data, version: createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex"), syncedAt: new Date().toISOString() };
    writeSealed(this.file(projectId), this.key, `bundle:${projectId}`, stored);
    return this.summary(stored);
  }
  get(projectId: string): BundleSummary | undefined { const stored = this.load(projectId); return stored && this.summary(stored); }
  remove(projectId: string): boolean { const file = this.file(projectId); if (!existsSync(file)) return false; rmSync(file, { force: true }); return true; }

  /** Writes declared files, removes stale ones this store wrote earlier, and returns env to inject. */
  materialize(projectId: string, cwd: string, notice: (type: string, message: string) => void): { env: Record<string, string>; version?: string } {
    const stored = this.load(projectId);
    const recordFile = this.file(projectId, "materialized.json");
    const previous: string[] = existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, "utf8")) : [];
    const written = new Set<string>();
    const env: Record<string, string> = {};
    const home = resolve(this.home), root = resolve(cwd);
    const write = (path: string, bytes: Buffer, mode: number) => {
      if (!within(home, path) && !within(root, path)) throw new BundleError(`Bundle destination is outside the agent home and project: ${path}`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, bytes, { mode: mode & 0o777 || 0o600, flag: "wx" });
      chmodSync(temporary, mode & 0o777 || 0o600);
      renameSync(temporary, path);
      written.add(path);
    };
    if (stored) {
      for (const item of stored.payload.items) {
        if (item.kind === "env") {
          for (const [name, value] of Object.entries(item.entries)) {
            if (name.startsWith("INFINITE_")) { notice("bundle-env-skipped", `${item.name}: ${name} is reserved`); continue; }
            env[name] = value;
          }
        } else if (item.kind === "file") write(target(item.to, root, home), Buffer.from(item.base64, "base64"), item.mode);
        else for (const f of item.files) write(join(target(item.to, root, home), ...f.path.split("/")), Buffer.from(f.base64, "base64"), f.mode);
      }
    }
    for (const stale of previous.filter(path => !written.has(path))) {
      if (!within(home, stale) && !within(root, stale)) continue;
      rmSync(stale, { force: true });
      let dir = dirname(stale);
      while ((within(home, dir) || within(root, dir)) && dir !== root && dir !== home) { try { rmdirSync(dir); } catch { break; } dir = dirname(dir); }
    }
    mkdirSync(dirname(recordFile), { recursive: true, mode: 0o700 });
    writeFileSync(recordFile, JSON.stringify([...written]), { mode: 0o600 });
    return { env, ...(stored ? { version: stored.version } : {}) };
  }
}
```

Remove the unused `posix` import.

- [ ] **Step 5: Wire manager, worker, server**

In `packages/host/src/manager.ts`:
- Import `BundleStore` and `homedir` from `node:os`; add a field `readonly bundles: BundleStore;` initialized in the constructor: `this.bundles = new BundleStore(config.stateDir, key, config.bundle?.home ?? homedir());`.
- In `createOnce`, after `const context = this.context(request.projectId);` add:

```ts
    const notices: { type: string; message: string }[] = [];
    const bundle = this.bundles.materialize(request.projectId, realpathSync(project.path), (type, message) => notices.push({ type, message }));
```

- Add `...(bundle.version ? { bundleVersion: bundle.version } : {}),` to the `session` literal after `executionLocation`.
- In the bootstrap JSON add `...(Object.keys(bundle.env).length ? { env: bundle.env } : {}),` and `notices,`. Add `notices?: { type: string; message: string }[];` to `Bootstrap` in `types.ts`.

In `packages/host/src/worker.ts` after `env.TERM = "xterm-256color";` add:

```ts
    for (const [name, value] of Object.entries(config.env ?? {})) if (!name.startsWith("INFINITE_")) env[name] = value;
    for (const notice of config.notices ?? []) record({ kind: "notice", type: notice.type, message: notice.message }, "host");
```

The `record` call requires the journal to be open; this block runs after `journal` exists, which it does at launch time.

In `packages/host/src/server.ts`:
- json limit middleware: add `: /^\/api\/projects\/[^/]+\/bundle$/.test(req.path) && req.method === "PUT" ? "128mb"` before the `"96kb"` fallback.
- Routes before `/api/projects/:id/context`:

```ts
  app.put("/api/projects/:id/bundle", requireRole(["owner"]), (req, res) => {
    if (!res.locals.bearer || req.headers.origin) return void res.status(403).json({ error: "Bundle upload requires a paired owner CLI" });
    const projectId = projectSchema.parse(req.params.id);
    if (!config.projects.some(p => p.id === projectId)) return void res.status(404).json({ error: "Unknown project" });
    res.json(manager.bundles.put(projectId, req.body));
  });
  app.get("/api/projects/:id/bundle", requireRole(["owner", "controller"]), (req, res) => {
    const summary = manager.bundles.get(projectSchema.parse(req.params.id));
    return summary ? res.json(summary) : res.status(404).json({ error: "No bundle" });
  });
  app.delete("/api/projects/:id/bundle", requireRole(["owner"]), (req, res) => {
    res.json({ removed: manager.bundles.remove(projectSchema.parse(req.params.id)) });
  });
```

- Error handler: `if (error instanceof BundleError) return res.status(error.status).json({ error: error.message });` (import it).
- `remote-access.ts` `allowedPath`: `if (method === "GET" && /^\/api\/projects\/[a-z0-9-]{1,80}\/bundle$/.test(url.pathname)) return true;`

- [ ] **Step 6: Run and commit**

Run: `npx tsx --test tests/bundle.test.ts tests/host-launch.test.ts tests/remote-access.test.ts`
Expected: PASS.

```bash
git add packages/host/src/bundle.ts packages/host/src/config.ts packages/host/src/types.ts packages/host/src/manager.ts packages/host/src/worker.ts packages/host/src/server.ts packages/host/src/remote-access.ts tests/bundle.test.ts
git commit -m "Store context bundles sealed and materialize them at session launch"
```

---

### Task 5: CLI `bundle` and `push` commands

**Files:**
- Modify: `packages/host/src/client.ts` (commands, options, `ClientConfig` type, `loadConfig` validation), `packages/host/src/client-entry.ts` (help)
- Test: extend `tests/client-args.test.ts`; `tests/transfer-cli.test.ts` (new)

**Interfaces:**
- Consumes: `collectBundle`, `bundleDeclarationSchema` (Task 3); routes from Tasks 2 and 4; `INBOX_CHUNK_BYTES`.
- Produces:

```
infinite bundle push [--project ID]     # read client.json "bundle", collect, PUT
infinite bundle list [--project ID]
infinite bundle remove [--project ID]
infinite push FILE [FILE...] --session SESSION_ID
```

`ClientConfig` gains `bundle?: BundleDeclaration`; `loadConfig` validates it with `bundleDeclarationSchema` and reports the offending key.

- [ ] **Step 1: Parse tests**

Append to `tests/client-args.test.ts`:

```ts
test("bundle and push commands parse", () => {
  const push = parseClientArgs(["push", "a.pdf", "b.csv", "--session", "5ba58d55-0000-4000-8000-000000000000"]);
  assert.equal(push.command, "push"); assert.deepEqual(push.args, ["a.pdf", "b.csv"]); assert.equal(push.options["--session"], "5ba58d55-0000-4000-8000-000000000000");
  const bundle = parseClientArgs(["bundle", "push", "--project", "example"]);
  assert.equal(bundle.command, "bundle"); assert.deepEqual(bundle.args, ["push"]); assert.equal(bundle.options["--project"], "example");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/client-args.test.ts`
Expected: FAIL on `--session`.

- [ ] **Step 3: Implement**

In `packages/host/src/client.ts`:
- `CLIENT_COMMANDS` add `"bundle", "push"`; `strings` add `"--session"`; candidate array add both.
- `ClientConfig` type: `type ClientConfig = { origin: string; token: string; projectId?: string; bundle?: BundleDeclaration };` and in `loadConfig` after the token check: `if (config.bundle !== undefined) { const parsed = bundleDeclarationSchema.safeParse(config.bundle); if (!parsed.success) throw new Error(`Invalid bundle declaration in client configuration: ${parsed.error.issues[0]?.path.join(".") || "bundle"}`); }`.
- Imports: `import { collectBundle, bundleDeclarationSchema, type BundleDeclaration } from "./bundle-client.js";` and `import { INBOX_CHUNK_BYTES } from "./inbox.js";` and `createHash` from `node:crypto`, `readFile`/`stat`/`open` from `node:fs/promises`.
- Add branches after `pull`:

```ts
    if (command === "bundle") {
      if (me.role !== "owner") throw new Error("Context bundles require an owner device key");
      const action = positional[0];
      const projectId = String(options["--project"] ?? config.projectId ?? me.projects[0]?.id ?? "");
      if (!me.projects.some(p => p.id === projectId)) throw new Error("Unknown project. Use infinite projects");
      if (action === "push") {
        if (!config.bundle) throw new Error(`Declare a "bundle" in ${path} first. See docs/context-transfer.md`);
        progress.start("Collecting declared bundle items");
        const payload = await collectBundle({ declaration: config.bundle, projectId, projectRoot: gitRoot(realpathSync(process.cwd())), home: realpathSync(homedir()) });
        progress.start(`Uploading ${payload.items.length} items`);
        const response = await fetch(config.origin + `/api/projects/${projectId}/bundle`, { method: "PUT", redirect: "error", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(300000) });
        progress.stop();
        if (!response.ok) throw new HttpError(response.status, `Host returned HTTP ${response.status} for the bundle upload.`);
        const summary = await response.json() as { version: string; items: { kind: string; name?: string; to?: string; bytes: number; files: number }[] };
        for (const item of summary.items) console.log(`${item.kind.padEnd(4)}  ${clean(item.name ?? item.to ?? "")}  ${item.bytes} bytes${item.kind === "dir" ? ` · ${item.files} files` : ""}`);
        console.error(`[Infinite] Bundle ${summary.version.slice(0, 12)} stored for ${projectId}. New sessions in that project receive it; running sessions keep their launch bundle.`);
        return true;
      }
      if (action === "list") {
        const response = await api.request(`/projects/${projectId}/bundle`).catch((error: HttpError) => { if (error.status === 404) return undefined; throw error; });
        if (!response) { console.log("No bundle is stored for this project."); return true; }
        const summary = await response.json() as { version: string; syncedAt: string; items: { kind: string; name?: string; to?: string; bytes: number; files: number }[] };
        console.log(`Bundle ${summary.version.slice(0, 12)} · synced ${age(summary.syncedAt)}`);
        for (const item of summary.items) console.log(`${item.kind.padEnd(4)}  ${clean(item.name ?? item.to ?? "")}  ${item.bytes} bytes${item.kind === "dir" ? ` · ${item.files} files` : ""}`);
        return true;
      }
      if (action === "remove") {
        const response = await fetch(config.origin + `/api/projects/${projectId}/bundle`, { method: "DELETE", redirect: "error", headers: { Authorization: `Bearer ${config.token}` } });
        if (!response.ok) throw new HttpError(response.status, "Bundle removal failed.");
        console.log((await response.json() as { removed: boolean }).removed ? "Bundle removed. Files it wrote are cleaned up at the next launch in this project." : "No bundle was stored.");
        return true;
      }
      throw new Error("Usage: infinite bundle push|list|remove [--project ID]");
    }
    if (command === "push") {
      if (!["owner", "controller"].includes(me.role)) throw new Error("Pushing files requires an owner or controller device key");
      if (!positional.length || !options["--session"]) throw new Error("Usage: infinite push FILE [FILE...] --session SESSION_ID");
      const { sessions } = await api.json<{ sessions: Session[] }>("/sessions");
      const target = await selectSession(sessions, String(options["--session"]), false);
      for (const file of positional) {
        const absolute = resolve(file);
        const info = await stat(absolute);
        if (!info.isFile()) throw new Error(`Not a regular file: ${file}`);
        const hash = createHash("sha256");
        const handle = await open(absolute, "r");
        try { for await (const block of handle.createReadStream({ autoClose: false })) hash.update(block as Buffer); } finally { await handle.close(); }
        const begin = await api.json<{ uploadId: string; chunkBytes: number; chunks: number; received: number[] }>(`/sessions/${target.id}/inbox`, { name: basename(absolute), size: info.size, sha256: hash.digest("hex") });
        progress.start(`Uploading ${basename(absolute)} (${begin.chunks} chunks)`);
        const pending = [...Array(begin.chunks).keys()].filter(i => !begin.received.includes(i));
        const reader = await open(absolute, "r");
        try {
          const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
            for (let index = pending.shift(); index !== undefined; index = pending.shift()) {
              const buffer = Buffer.alloc(Math.min(begin.chunkBytes, info.size - index * begin.chunkBytes));
              await reader.read(buffer, 0, buffer.length, index * begin.chunkBytes);
              const response = await fetch(config.origin + `/api/sessions/${target.id}/inbox/${begin.uploadId}/chunks/${index}`, { method: "PUT", redirect: "error", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ base64: buffer.toString("base64") }), signal: AbortSignal.timeout(60000) });
              if (!response.ok) throw new HttpError(response.status, `Chunk ${index} was refused.`);
            }
          });
          await Promise.all(workers);
        } finally { await reader.close(); }
        const receipt = await api.json<{ path: string; bytes: number; sha256: string; notified: boolean }>(`/sessions/${target.id}/inbox/${begin.uploadId}/complete`, {});
        progress.stop();
        console.log(`${receipt.path}  ${receipt.bytes} bytes  sha256 ${receipt.sha256.slice(0, 12)}${receipt.notified ? "" : "  (agent not notified; mention the path yourself)"}`);
      }
      return true;
    }
```

Import `basename` from `node:path`. `INBOX_CHUNK_BYTES` is not needed if `begin.chunkBytes` is used; drop that import.

- Help text in `client-entry.ts`: add

```
infinite push FILE [FILE...] --session SESSION_ID
infinite bundle push|list|remove [--project ID]
```

- [ ] **Step 4: CLI-level test**

Create `tests/transfer-cli.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { startHost, waitFor } from "./helpers.js";

const exec = promisify(execFile);

test("infinite bundle push/list/remove and infinite push work end to end", { timeout: 120000 }, async () => {
  const host = await startHost();
  const root = realpathSync(mkdtempSync("/tmp/inf-transfer-"));
  const home = join(root, "home"), checkout = join(home, "code", "example"); mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, ".env.local"), "TOKEN=abc\n");
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Dev\n");
  const clientFile = join(root, "client.json"), tokenFile = join(root, "owner.key");
  writeFileSync(tokenFile, host.tokens.owner, { mode: 0o600 });
  const cli = ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/cli.ts"), "--client-config", clientFile];
  const env = { ...process.env, HOME: home };
  try {
    await exec(process.execPath, [...cli, "pair", host.origin, "--token-file", tokenFile], { env });
    const config = JSON.parse(readFileSync(clientFile, "utf8"));
    config.bundle = { global: [{ kind: "file", from: "~/.gitconfig" }], projects: { rehearsal: [{ kind: "env", from: ".env.local" }] } };
    writeFileSync(clientFile, JSON.stringify(config), { mode: 0o600 });
    const pushed = await exec(process.execPath, [...cli, "bundle", "push", "--project", "rehearsal"], { cwd: checkout, env });
    assert.match(pushed.stdout, /file\s+~\/\.gitconfig/); assert.match(pushed.stdout, /env\s+\.env\.local/);
    assert.equal(pushed.stdout.includes("abc"), false);
    const listed = await exec(process.execPath, [...cli, "bundle", "list", "--project", "rehearsal"], { env });
    assert.match(listed.stdout, /Bundle [a-f0-9]{12}/);
    const removed = await exec(process.execPath, [...cli, "bundle", "remove", "--project", "rehearsal"], { env });
    assert.match(removed.stdout, /removed/);

    const id = randomUUID();
    await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Push", prompt: "" });
    await waitFor(() => host.fetchApi(`/sessions/${id}`), r => r.body.status === "running");
    const file = join(root, "data.bin"); writeFileSync(file, randomBytes(200 * 1024));
    const out = await exec(process.execPath, [...cli, "push", file, "--session", id], { env });
    assert.match(out.stdout, /^\.infinite\/inbox\/data\.bin\s+204800 bytes/m);
    assert.ok(Buffer.from(readFileSync(join(host.config.projects[0].path, ".infinite", "inbox", "data.bin"))).equals(readFileSync(file)));
  } finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 5: Run and commit**

Run: `npx tsx --test tests/client-args.test.ts tests/transfer-cli.test.ts`
Expected: PASS.

```bash
git add packages/host/src/client.ts packages/host/src/client-entry.ts tests/client-args.test.ts tests/transfer-cli.test.ts
git commit -m "Add infinite bundle and infinite push commands"
```

---

### Task 6: Web drop zone and bundle listing

**Files:**
- Modify: `apps/web/src/api.ts` (types), `apps/web/src/session-extras.tsx` (new `InboxDrop` component), `apps/web/src/main.tsx` (render `InboxDrop` in the session detail next to the existing Files view, and a bundle line on the Create screen under the sync line from the previous plan), `apps/web/src/style.css` (drop zone styles)

- [ ] **Step 1: Types and upload helper**

In `apps/web/src/api.ts` add:

```ts
export type InboxBegin = { uploadId: string; chunkBytes: number; chunks: number; received: number[] };
export type InboxReceipt = { path: string; bytes: number; sha256: string; receivedAt: string; notified: boolean };
export type BundleSummary = { version: string; syncedAt: string; items: { kind: "env" | "file" | "dir"; name?: string; to?: string; bytes: number; files: number }[] };
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function toBase64(bytes: Uint8Array): string {
  let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export async function uploadToInbox(api: Api, sessionId: string, file: File, onProgress: (done: number, total: number) => void): Promise<InboxReceipt> {
  const data = await file.arrayBuffer();
  const begin = await api<InboxBegin>(`/sessions/${sessionId}/inbox`, { name: file.name, size: file.size, sha256: await sha256Hex(data) });
  const pending = [...Array(begin.chunks).keys()].filter(i => !begin.received.includes(i));
  let done = begin.received.length;
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    for (let index = pending.shift(); index !== undefined; index = pending.shift()) {
      const chunk = new Uint8Array(data, index * begin.chunkBytes, Math.min(begin.chunkBytes, file.size - index * begin.chunkBytes));
      await api(`/sessions/${sessionId}/inbox/${begin.uploadId}/chunks/${index}`, { base64: toBase64(chunk) }, "PUT");
      onProgress(++done, begin.chunks);
    }
  }));
  return api<InboxReceipt>(`/sessions/${sessionId}/inbox/${begin.uploadId}/complete`, {});
}
```

- [ ] **Step 2: `InboxDrop` component**

Append to `apps/web/src/session-extras.tsx`:

```tsx
export function InboxDrop({ id, enabled }: { id: string; enabled: boolean }) {
  const api = useApi();
  const [over, setOver] = useState(false);
  const [status, setStatus] = useState("");
  const [receipts, setReceipts] = useState<InboxReceipt[]>([]);
  const input = useRef<HTMLInputElement>(null);
  async function send(files: FileList | null) {
    if (!files?.length || !enabled) return;
    for (const file of Array.from(files)) {
      if (file.size > 256 * 1024 * 1024) { setStatus(`${file.name} is larger than 256 MiB.`); continue; }
      try {
        setStatus(`Uploading ${file.name}…`);
        const receipt = await uploadToInbox(api, id, file, (done, total) => setStatus(`Uploading ${file.name}: ${done}/${total}`));
        setReceipts(previous => [receipt, ...previous].slice(0, 20));
        setStatus(receipt.notified ? `Added ${receipt.path}. The agent was told.` : `Added ${receipt.path}. The agent was not notified; mention the path in your next message.`);
      } catch (error) { setStatus(`${file.name}: ${(error as Error).message}`); }
    }
  }
  return <section className={`inbox-drop ${over ? "over" : ""} ${enabled ? "" : "disabled"}`}
    onDragOver={event => { event.preventDefault(); if (enabled) setOver(true); }} onDragLeave={() => setOver(false)}
    onDrop={event => { event.preventDefault(); setOver(false); void send(event.dataTransfer.files); }}>
    <p>Drop files here to add them to this session's inbox, or <button type="button" className="text-button" disabled={!enabled} onClick={() => input.current?.click()}>choose files</button>.</p>
    <input ref={input} type="file" multiple hidden onChange={event => { void send(event.target.files); event.target.value = ""; }} />
    {status && <p className="quiet" role="status">{status}</p>}
    {receipts.length > 0 && <ul className="inbox-receipts">{receipts.map(r => <li key={r.sha256 + r.receivedAt}><code>{r.path}</code> · {r.bytes.toLocaleString()} bytes</li>)}</ul>}
  </section>;
}
```

Import `useRef`, `useState` (already imported), `uploadToInbox`, `InboxReceipt` from `./api`.

In `apps/web/src/main.tsx`, find where the Files view is rendered for a session (search for `<Files` or the `file?path=` usage) and render `<InboxDrop id={id} enabled={connected && me.role !== "viewer" && session.status === "running" && session.backend !== "cmux" && session.executionLocation !== "laptop"} />` directly above it. On the Create screen, under the sync status paragraph, add a bundle fetch (`api<BundleSummary>(`/projects/${projectId}/bundle`)`, 404 → none) rendering `Bundle: N items · synced …` or `No context bundle`. Keep values out: the summary has none.

Add to `apps/web/src/style.css`:

```css
.inbox-drop { border: 1px dashed var(--rule, #999); border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
.inbox-drop.over { border-style: solid; }
.inbox-drop.disabled { opacity: 0.6; }
.inbox-receipts { margin: 8px 0 0; padding-left: 18px; }
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck -w @infinite/web && npm run build -w @infinite/web`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/session-extras.tsx apps/web/src/main.tsx apps/web/src/style.css
git commit -m "Add a web inbox drop zone and bundle summary"
```

---

### Task 7: Phone file picker upload

**Files:**
- Modify: `apps/mobile/package.json` (add `expo-document-picker`, `expo-file-system`), `apps/mobile/src/api/client.ts` (types and `uploadToInbox`), `apps/mobile/src/features/session/Files.tsx` (Add file button)

- [ ] **Step 1: Install dependencies**

Run from `apps/mobile`: `npx expo install expo-document-picker expo-file-system`
Expected: both appear in `apps/mobile/package.json` with `~57.x` versions and the root lockfile updates.

- [ ] **Step 2: Upload helper**

In `apps/mobile/src/api/client.ts` add:

```ts
export type InboxBegin = { uploadId: string; chunkBytes: number; chunks: number; received: number[] };
export type InboxReceipt = { path: string; bytes: number; sha256: string; receivedAt: string; notified: boolean };
export const PHONE_INBOX_MAX_BYTES = 64 * 1024 * 1024;
export async function uploadToInbox(connection: Connection, sessionId: string, file: { uri: string; name: string; size: number }, onProgress: (done: number, total: number) => void): Promise<InboxReceipt> {
  const { File } = await import("expo-file-system");
  const bytes = await new File(file.uri).bytes();
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  const sha256 = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  const begin = await api<InboxBegin>(connection, `/sessions/${sessionId}/inbox`, { body: { name: file.name, size: bytes.length, sha256 } });
  const pending = [...Array(begin.chunks).keys()].filter(i => !begin.received.includes(i));
  let done = begin.received.length;
  const toBase64 = (chunk: Uint8Array) => { let s = ""; for (let i = 0; i < chunk.length; i += 0x8000) s += String.fromCharCode(...chunk.subarray(i, i + 0x8000)); return globalThis.btoa(s); };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    for (let index = pending.shift(); index !== undefined; index = pending.shift()) {
      await api(connection, `/sessions/${sessionId}/inbox/${begin.uploadId}/chunks/${index}`, { method: "PUT", body: { base64: toBase64(bytes.subarray(index * begin.chunkBytes, (index + 1) * begin.chunkBytes)) } });
      onProgress(++done, begin.chunks);
    }
  }));
  return api<InboxReceipt>(connection, `/sessions/${sessionId}/inbox/${begin.uploadId}/complete`, { body: {} });
}
```

`Crypto` is already imported in this file as `expo-crypto`. If `btoa` is unavailable in the RN runtime, add `import { encode as btoa } from "base-64"` only if that package already exists; otherwise implement a small base64 encoder table in the same file.

- [ ] **Step 3: Files screen button**

In `Files.tsx` add state `const [upload, setUpload] = useState("");` and a function:

```tsx
  async function addFile() {
    const picker = await import("expo-document-picker");
    const picked = await picker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    if (picked.canceled || !picked.assets?.[0]) return;
    const asset = picked.assets[0];
    if ((asset.size ?? 0) > PHONE_INBOX_MAX_BYTES) { setUpload("Files above 64 MiB are not uploaded from the phone."); return; }
    try {
      setUpload(`Uploading ${asset.name}…`);
      const receipt = await uploadToInbox(connection, id, { uri: asset.uri, name: asset.name, size: asset.size ?? 0 }, (done, total) => setUpload(`Uploading ${asset.name}: ${done}/${total}`));
      setUpload(receipt.notified ? `Added ${receipt.path}. The agent was told.` : `Added ${receipt.path}. Mention the path in your next message.`);
    } catch (error) { setUpload((error as Error).message); }
  }
```

Render above the path input: `<Button title="Add file to inbox" secondary disabled={!online || !canUpload} onPress={() => void addFile()} />` and `{upload ? <Text style={s.note} accessibilityRole="status">{upload}</Text> : null}`. Add a `canUpload: boolean` prop to `Files` and pass `me?.role !== "viewer" && session.status === "running" && session.backend !== "cmux" && session.executionLocation !== "laptop"` from its parent (search for `<Files ` in `apps/mobile/src/app` or `features/session/SessionGate.tsx`).

- [ ] **Step 4: Lint and typecheck**

Run from `apps/mobile`: `npm run lint && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/package.json package-lock.json apps/mobile/src/api/client.ts apps/mobile/src/features/session/Files.tsx apps/mobile/src/features/session/SessionGate.tsx
git commit -m "Upload files to a session inbox from the phone"
```

(Adjust the file list if the `Files` parent is a different file.)

---

### Task 8: Documentation and spec amendments

**Files:**
- Create: `docs/context-transfer.md`
- Modify: `docs/cli.md`, `docs/security.md`, `docs/remote-machines.md` ("Sessions and cmux" section), `docs/architecture.md` (API table), `docs/superpowers/specs/2026-10-16-cloud-first-execution-design.md`

- [ ] **Step 1: `docs/context-transfer.md`**

```
# Context transfer: bundles and the inbox

Cloud sessions need the files, secrets, and configuration the owner's Mac has. Two mechanisms move them. [Workspace sync](workspace-sync.md) moves the project tree. This page covers everything else.

## Context bundle

A bundle is the set of declared secrets and configuration a project's sessions receive. The declaration lives in the private client configuration beside the device key, under `bundle`:

```json
{
  "bundle": {
    "global": [
      { "kind": "file", "from": "~/.gitconfig" }
    ],
    "projects": {
      "example": [
        { "kind": "env", "from": ".env.local" },
        { "kind": "file", "from": "~/deploy.key", "to": "~/.ssh/deploy_example", "mode": "0600" },
        { "kind": "dir", "from": "~/.config/example-cli" }
      ]
    }
  }
}
```

`env` merges a dotenv file into the session environment. `file` and `dir` are placed at `to`, which is `~/...` under the agent home or a project-relative path; `to` defaults to the source's own location. `from` resolves under the home directory for `~/...`, under the Git root for relative paths. Paths outside those two roots, `..` segments, symlinks, items above 16 MiB, and bundles above 64 MiB are refused by name before anything is read. Nothing outside the declaration is read.

`infinite bundle push --project ID` collects the items and uploads them over the authenticated connection. The host seals the payload with its vault key and records a version hash and sync time. `infinite bundle list` and the web and phone create screens show kinds, destinations, sizes, and the sync time; no client ever receives a value.

At each session launch in that project the host writes `file` and `dir` items fresh, injects `env` entries into the process environment, records what it wrote, and removes files it wrote for an earlier version that the current declaration no longer names. Files the bundle never wrote are left alone. Environment names beginning with `INFINITE_` are skipped and journaled. The session record keeps the bundle version it started with; running sessions do not change when a new bundle arrives.

`~/` targets resolve against `bundle.home` in the host configuration when set, otherwise the API process home. A deployment that runs agents under a separate account must set `bundle.home` to that account's home and make it writable by the API identity.

Values on the host are readable by any agent in that project and by the host administrator. This is the single-tenant trust boundary. Browser cookies, keychains, and browser profiles are never part of a bundle.

## Drop inbox

Any owner or controller can add a file to a running Infinite session from the web session view (drag and drop or choose files), the phone Files tab, or `infinite push FILE --session ID`. Files land in `.infinite/inbox/` inside the session workspace under their original name; a name collision appends a short hash suffix. Nothing is overwritten.

Uploads are chunked at 64 KiB over every transport, up to 256 MiB per file (64 MiB from the phone), and resume by upload id after a dropped connection or an API restart. On completion the host returns a receipt with path, size, sha256, and whether the agent was told. The worker journals a host notice that Chat shows as "Added .infinite/inbox/NAME to this session's inbox". For a provider whose Chat is terminal-only, mention the path in your next message.

The inbox is refused for cmux sessions, which have no Infinite-owned workspace, and for `--laptop` sessions, whose files live on the laptop. `.infinite/` is carried across workspace sync applies and ignored by drift detection, so inbox files survive a new generation.
```

- [ ] **Step 2: Other docs**

`docs/cli.md`: add after the "Workspace sync and pull" section:

```
## Context bundle and inbox

```sh
infinite bundle push --project PROJECT_ID
infinite bundle list --project PROJECT_ID
infinite bundle remove --project PROJECT_ID
infinite push report.pdf data.csv --session SESSION_ID
```

See [context transfer](context-transfer.md) for the declaration format, limits, and what the agent sees.
```

`docs/security.md`, "Threats that remain", add a bullet:

```
- Context bundle values are materialized into the agent home and project on the host and are readable by every agent in that project and by the host administrator. Inbox files are untrusted input to the agent like any other file. Declarations are validated on the laptop before any read; nothing outside the declaration is collected.
```

`docs/remote-machines.md`, in "Sessions and cmux" after the Files paragraph, add: `Inbox uploads add a file to a running Infinite session's .infinite/inbox/ directory from web or phone; they are refused for cmux sessions. See [context transfer](context-transfer.md).`

`docs/architecture.md` API table, add:

```
| Context bundle | `PUT`/`GET`/`DELETE /api/projects/:id/bundle` | Owner CLI / owner, controller / owner |
| Inbox upload | `POST /api/sessions/:id/inbox`, `PUT .../inbox/:uploadId/chunks/:index`, `POST .../inbox/:uploadId/complete`, `GET .../inbox/:uploadId` | Owner, controller |
```

- [ ] **Step 3: Spec amendments**

In the spec:
- "Context bundle" → replace `The laptop service reads the declared items, encrypts the bundle to the host's vault key, and uploads it with PUT /api/projects/:id/bundle as an owner.` with `The laptop CLI reads the declared items and uploads them over the authenticated connection with PUT /api/projects/:id/bundle as an owner; the host seals the payload with its vault key at rest.`
- "Drop inbox" → replace `Uploads are chunked at 4 MiB, limited to 256 MiB per file, and resumable by file hash.` with `Uploads are chunked at 64 KiB over every transport, limited to 256 MiB per file (64 MiB from the phone), and resumable by upload id.` Replace `the worker journals a host signal of kind inbox-file` with `the worker journals a host notice of type inbox-file`. Replace `the phone share sheet and file picker` with `the phone file picker (share-sheet receiving is a follow-up)`.
- "API summary" → replace the chunk sentence `Chunked upload frames fit the existing 96 KiB request limit by using 64 KiB chunks over the relay and 4 MiB chunks over direct HTTPS.` with `Inbox chunks are 64 KiB as base64 JSON on every transport, which fits the 96 KiB relay request limit; bundle upload and workspace sync transfer are direct-only CLI operations.`

- [ ] **Step 4: Scan and commit**

Run: `git add -A docs && git diff --cached | grep -n -I -E '/Users/|/home/[a-z0-9_-]+/|~/(Library|Projects|Documents|Desktop)|\.ts\.net|SHA256:|BEGIN [A-Z ]*PRIVATE KEY|([0-9]{1,3}\.){3}[0-9]{1,3}'`
Expected: no hits beyond documentation examples.

```bash
git commit -m "Document context bundles and the session inbox"
```

---

### Task 9: Full check

- [ ] Run: `npm run check && npm run lint -w @infinite/mobile && (cd apps/mobile && npx tsc --noEmit)`
Expected: clean.
