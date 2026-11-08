import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorkspace, readWorkspaceBlob, WORKSPACE_LIMITS } from "../packages/host/src/workspace-checkpoint.js";
import { createHybridWorkspace } from "../packages/host/src/hybrid-workspace.js";

async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "hybrid-workspace-transfer-"));
  const root = join(base, "workspace"), directory = join(base, "control");
  mkdirSync(root);
  const canonicalRoot = realpathSync(root);
  const hybrid = await createHybridWorkspace({
    workspace: { cwd: canonicalRoot, roots: [canonicalRoot] },
    directory,
    record: () => {},
    publish: () => {},
    select: async () => {},
  });
  return { base, root: canonicalRoot, directory, hybrid };
}

test("hybrid publication waits for all admitted chunk uploads", { timeout: 30000 }, async t => {
  const f = await fixture();
  t.after(async () => { await f.hybrid.close(); rmSync(f.base, { recursive: true, force: true }); });
  const chunkBytes = WORKSPACE_LIMITS.chunkBytes;
  const contents = Buffer.concat(Array.from({ length: 8 }, (_, index) => Buffer.alloc(chunkBytes, index + 1)));
  writeFileSync(join(f.root, "chunks.bin"), contents);
  const laptopStore = join(f.base, "laptop-store");
  const manifest = await captureWorkspace({ roots: [f.root], cwd: f.root, storeDir: laptopStore });
  const hashes = [...new Set(manifest.entries.flatMap(entry => entry.chunks ?? []))];
  const blobs = await Promise.all(hashes.map(async hash => ({ hash, base64: await readWorkspaceBlob(laptopStore, hash) })));
  f.hybrid.connection(true);
  f.hybrid.activity({ revision: 3, busy: false, uncertain: false });
  f.hybrid.providerReady(true);
  const begin = await f.hybrid.control("sync/begin");

  const uploads = blobs.map(blob => f.hybrid.control("sync/blob", blob));
  const committed = await f.hybrid.control("sync/commit", { ...begin, manifest });
  await Promise.all(uploads);
  assert.equal(committed.checkpoint.id, manifest.id, "the host acknowledges the complete checkpoint");
  const prepared = readdirSync(f.directory).find(name => name.startsWith("prepared-"));
  assert.ok(prepared, "the host materializes the uploaded checkpoint");
  assert.deepEqual(readFileSync(join(f.directory, prepared, "workspace", f.root.slice(1), "chunks.bin")), contents);
});

test("a state barrier waits for prior blobs without including later blobs", { timeout: 10000 }, async t => {
  const f = await fixture();
  t.after(async () => { await f.hybrid.close(); rmSync(f.base, { recursive: true, force: true }); });
  const firstBytes = Buffer.from("first blob");
  const secondBytes = Buffer.from("second blob");
  const firstHash = createHash("sha256").update(firstBytes).digest("hex");
  const secondHash = createHash("sha256").update(secondBytes).digest("hex");

  const first = f.hybrid.control("sync/blob", { hash: firstHash, base64: firstBytes.toString("base64") });
  const status = f.hybrid.control("sync/status");
  const second = f.hybrid.control("sync/blob", { hash: secondHash, base64: secondBytes.toString("base64") });
  const [firstResult, state, secondResult] = await Promise.all([first, status, second]);
  assert.equal(firstResult.stored, true);
  assert.equal(state.location, "laptop");
  assert.equal(secondResult.stored, true);
});

test("hybrid close drains admitted blob writes before callers clean up", { timeout: 30000 }, async t => {
  const f = await fixture();
  t.after(async () => { await f.hybrid.close(); rmSync(f.base, { recursive: true, force: true }); });
  const chunkBytes = WORKSPACE_LIMITS.chunkBytes;
  const blobs = Array.from({ length: 8 }, (_, index) => {
    const bytes = Buffer.alloc(chunkBytes, index + 1);
    return { hash: createHash("sha256").update(bytes).digest("hex"), bytes };
  });
  let settled = 0;
  const uploads = blobs.map(({ hash, bytes }) => f.hybrid.control("sync/blob", { hash, base64: bytes.toString("base64") })
    .then(() => { settled += 1; }, () => { settled += 1; }));
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(settled < uploads.length, "close begins while admitted uploads remain unsettled");

  await f.hybrid.close();
  await Promise.all(uploads);
  assert.equal(settled, uploads.length, "close resolves only after every admitted upload settles");
});
