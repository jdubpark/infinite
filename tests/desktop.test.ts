import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashToken } from "../packages/host/src/config.js";
import { DESKTOP_LIMITS } from "../packages/host/src/desktop.js";
import { inProcessHost, startHost } from "./helpers.js";

const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
type TestHost = Pick<Awaited<ReturnType<typeof inProcessHost>>, "fetchApi">;
async function stage(host: TestHost, path: string, data: Buffer, expectedHash: string | null = null) {
  const started = await host.fetchApi("/projects/rehearsal/uploads", "owner", { path, size: data.length, sha256: digest(data), expectedHash });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const upload = `/projects/rehearsal/uploads/${started.body.uploadId}`;
  for (let offset = 0; offset < data.length; offset += DESKTOP_LIMITS.chunkBytes) {
    const body = { offset, base64: data.subarray(offset, offset + DESKTOP_LIMITS.chunkBytes).toString("base64") };
    const sent = await host.fetchApi(upload, "owner", body, {}, "PUT");
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
  }
  return upload;
}

test("desktop transfers preserve binary bytes, retry chunks, pin reads, and reject stale concurrent writes", async () => {
  const host = await inProcessHost();
  try {
    const root = host.config.projects[0].path;
    host.config.sync = { sharedGroup: true };
    // The setgid fixture uses a group this test process actually belongs to.
    chownSync(root, process.getuid!(), process.getgid!());
    assert.equal((await host.fetchApi("/projects/rehearsal/directories", "viewer", { path: "incoming/nested" })).status, 403);
    assert.equal((await host.fetchApi("/projects/rehearsal/directories", "owner", { path: "incoming/nested" })).status, 200);
    assert.equal(statSync(join(root, "incoming/nested")).mode & 0o2777, 0o2770);
    assert.equal((await host.fetchApi("/projects/rehearsal/directories", "owner", { path: "incoming/nested" })).status, 200);
    const content = randomBytes(DESKTOP_LIMITS.chunkBytes * 2 + 73), path = "incoming/nested/data.bin";
    const upload = await stage(host, path, content);
    const retried = await host.fetchApi(upload, "owner", { offset: 0, base64: content.subarray(0, DESKTOP_LIMITS.chunkBytes).toString("base64") }, {}, "PUT");
    assert.equal(retried.body.offset, content.length);
    const committed = await host.fetchApi(`${upload}/commit`, "owner", {});
    assert.equal(committed.status, 200); assert.equal(committed.body.sha256, digest(content));
    assert.deepEqual((await host.fetchApi(`${upload}/commit`, "owner", {})).body, committed.body);
    assert.deepEqual(readFileSync(join(root, path)), content);
    assert.equal(statSync(join(root, path)).mode & 0o777, 0o660, "separate agent identity can read and edit uploaded files through the shared group");
    const metadata = await host.fetchApi(`/projects/rehearsal/file?path=${path}&length=0`, "viewer");
    assert.equal(metadata.body.base64, ""); assert.equal(metadata.body.sha256, digest(content));
    assert.equal((await host.fetchApi(`/projects/rehearsal/file?path=${path}&offset=1`)).body.code, "file-version-required");
    const parts: Buffer[] = [];
    for (let offset = 0; offset < content.length;) {
      const page = await host.fetchApi(`/projects/rehearsal/file?path=${path}&offset=${offset}&sha256=${digest(content)}`, "viewer");
      assert.equal(page.status, 200); parts.push(Buffer.from(page.body.base64, "base64")); offset = page.body.nextOffset;
    }
    assert.deepEqual(Buffer.concat(parts), content);
    const first = await stage(host, path, Buffer.from("first writer"), digest(content));
    const second = await stage(host, path, Buffer.from("second writer"), digest(content));
    const results = await Promise.all([first, second].map(id => host.fetchApi(`${id}/commit`, "owner", {})));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    assert.equal((await host.fetchApi(`/projects/rehearsal/file?path=${path}&sha256=${digest(content)}`)).body.code, "file-conflict");
    assert.equal((await host.fetchApi(`/projects/rehearsal/file?path=${path}`, "owner", { expectedHash: digest(content) }, {}, "DELETE")).status, 409);
    const current = readFileSync(join(root, path));
    assert.equal((await host.fetchApi(`/projects/rehearsal/file?path=${path}`, "owner", { expectedHash: digest(current) }, {}, "DELETE")).status, 200);
    assert.equal(existsSync(join(root, path)), false);
  } finally { await host.stop(); }
});

test("desktop replacements keep shared-group agent access and preserve nonshared permissions", async () => {
  const host = await inProcessHost();
  try {
    const root = host.config.projects[0].path;
    const group = process.getgroups!().find(id => id !== process.getgid!()) ?? process.getgid!();
    chownSync(root, process.getuid!(), group);
    const cases = [
      { policy: "configured", previous: null, expected: 0o660 },
      { policy: "configured", previous: 0o640, expected: 0o660 },
      { policy: "setgid", previous: 0o750, expected: 0o770 },
      { policy: "configured", previous: 0o744, expected: 0o770 },
      { policy: "configured", previous: 0o440, expected: 0o460 },
      { policy: "private", previous: 0o754, expected: 0o754 },
    ];
    for (const [index, item] of cases.entries()) {
      host.config.sync = { sharedGroup: item.policy === "configured" };
      chmodSync(root, item.policy === "setgid" ? 0o2770 : 0o700);
      const path = `replacement-${index}.txt`, original = Buffer.from("previous version"), replacement = Buffer.from("uploaded version");
      if (item.previous !== null) { writeFileSync(join(root, path), original); chmodSync(join(root, path), item.previous); }
      const upload = await stage(host, path, replacement, item.previous === null ? null : digest(original));
      const result = await host.fetchApi(`${upload}/commit`, "owner", {});
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(readFileSync(join(root, path)), replacement);
      const published = statSync(join(root, path));
      if (item.policy !== "private") assert.equal(published.gid, group, "shared uploads use the destination directory group, not the private staging group");
      assert.equal(published.mode & 0o777, item.expected,
        `${item.policy}: replacing a file transfers ownership to the host, so shared permissions must still let the agent edit it`);
    }
  } finally { await host.stop(); }
});

test("desktop browsing and transfer cannot escape roots, follow symlinks, read pipes, or cross owner identities", async () => {
  const host = await inProcessHost();
  try {
    const root = host.config.projects[0].path;
    writeFileSync(join(host.root, "outside.txt"), "outside");
    mkdirSync(join(root, "folder")); writeFileSync(join(root, "folder", "a.txt"), "a"); writeFileSync(join(root, "folder", "b.txt"), "b");
    symlinkSync(host.root, join(root, "escape")); symlinkSync(join(root, "folder"), join(root, "inside-link"));
    execFileSync("mkfifo", [join(root, "pipe")]);
    for (const path of ["../outside.txt", "escape/outside.txt", "inside-link/a.txt", "/outside.txt"]) {
      const read = await host.fetchApi(`/projects/rehearsal/file?path=${encodeURIComponent(path)}`);
      assert.ok([400, 403].includes(read.status), `${path}: ${read.status}`);
      const write = await host.fetchApi("/projects/rehearsal/uploads", "owner", { path, size: 0, sha256: digest(""), expectedHash: null });
      assert.ok([400, 403].includes(write.status));
    }
    assert.equal((await host.fetchApi("/projects/rehearsal/file?path=pipe")).status, 400);
    assert.equal((await host.fetchApi("/projects/rehearsal/directories", "owner", { path: "escape/created" })).status, 403);
    assert.equal(existsSync(join(host.root, "created")), false);
    const list = await host.fetchApi("/projects/rehearsal/files?path=folder&limit=1", "viewer");
    assert.equal(list.status, 200); assert.equal(list.body.entries[0].name, "a.txt");
    writeFileSync(join(root, "folder", "c.txt"), "c");
    assert.equal((await host.fetchApi(`/projects/rehearsal/files?path=folder&limit=1&cursor=${list.body.nextCursor}`)).body.code, "directory-changed");
    const upload = await stage(host, "owner.txt", Buffer.from("owner"));
    const secondToken = randomBytes(32).toString("base64url");
    host.config.tokens.push({ id: "other-owner", label: "Other owner", role: "owner", hash: hashToken(secondToken) });
    const other = await fetch(`${host.origin}/api${upload}/commit`, { method: "POST", headers: { Authorization: `Bearer ${secondToken}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(other.status, 404);
    assert.equal((await host.fetchApi(`${upload}/commit`, "controller", {})).status, 403);
    assert.equal((await host.fetchApi(`${upload}/commit`, "owner", {})).status, 200);
    assert.equal(readFileSync(join(host.root, "outside.txt"), "utf8"), "outside");
  } finally { await host.stop(); }
});

test("uploads enforce declared content and bounds without publishing partial files", async () => {
  const host = await inProcessHost();
  try {
    const begin = (path: string, size = 3) => host.fetchApi("/projects/rehearsal/uploads", "owner", { path, size, sha256: digest("abc"), expectedHash: null });
    assert.equal((await begin("large", DESKTOP_LIMITS.maxFileBytes + 1)).status, 400);
    const first = await begin("incomplete"), route = `/projects/rehearsal/uploads/${first.body.uploadId}`;
    assert.equal((await host.fetchApi(`${route}/commit`, "owner", {})).body.code, "upload-incomplete");
    assert.equal((await host.fetchApi(route, "owner", { offset: 1, base64: "YQ==" }, {}, "PUT")).body.code, "invalid-offset");
    assert.equal((await host.fetchApi(route, "owner", { offset: 0, base64: "YQ" }, {}, "PUT")).body.code, "invalid-chunk");
    assert.equal((await host.fetchApi(route, "owner", { offset: 0, base64: Buffer.from("xyz").toString("base64") }, {}, "PUT")).status, 200);
    assert.equal((await host.fetchApi(`${route}/commit`, "owner", {})).body.code, "hash-mismatch");
    assert.equal(existsSync(join(host.config.projects[0].path, "incomplete")), false);
    for (let i = 1; i < DESKTOP_LIMITS.uploads; i++) assert.equal((await begin(`pending-${i}`)).status, 200);
    assert.equal((await begin("overflow")).status, 429);
    assert.equal((await host.fetchApi(route, "owner", undefined, {}, "DELETE")).status, 200);
    assert.equal((await begin("after-abort")).status, 200);
    assert.equal((await host.fetchApi(`${route}/commit`, "owner", {})).status, 404);
  } finally { await host.stop(); }
});

test("resources report timestamps and session paths; running sessions fence destructive file publication", { timeout: 30000 }, async () => {
  const host = await startHost();
  try {
    const before = await host.fetchApi("/machine/resources", "viewer");
    assert.equal(before.status, 200); assert.ok(Number.isFinite(Date.parse(before.body.capturedAt)));
    assert.equal(before.body.cpu.usagePercent, null); assert.ok(before.body.memory.totalBytes > 0);
    assert.equal(before.body.disks[0].projectId, "rehearsal");
    assert.ok(before.body.disks[0].totalInodes > 0); assert.ok(before.body.disks[0].availableInodes >= 0);
    const stateVolume = before.body.volumes.find((volume: { label: string }) => volume.label === "state");
    assert.ok(stateVolume); assert.equal(stateVolume.path, host.config.stateDir);
    assert.ok(stateVolume.totalBytes > 0); assert.ok(stateVolume.availableBytes >= 0);
    assert.ok(stateVolume.totalInodes > 0); assert.ok(stateVolume.availableInodes >= 0);
    assert.ok(Number.isFinite(stateVolume.fullness));
    const configuredVolumePaths = [host.config.stateDir, host.config.teams?.workspaceDir].filter(Boolean);
    assert.ok(before.body.volumes.every((volume: { path: string }) => configuredVolumePaths.includes(volume.path)));
    const upload = await stage(host, "pending.txt", Buffer.from("pending"));
    const requestId = randomUUID();
    assert.equal((await host.fetchApi("/sessions", "owner", { requestId, provider: "demo", projectId: "rehearsal", title: "Metrics fixture" })).status, 201);
    const sessions = await host.fetchApi("/sessions");
    assert.equal(sessions.body.sessions[0].cwd, realpathSync(host.config.projects[0].path));
    assert.equal((await host.fetchApi(`${upload}/commit`, "owner", {})).body.code, "session-running");
    assert.equal(existsSync(join(host.config.projects[0].path, "pending.txt")), false);
    await new Promise(resolve => setTimeout(resolve, 1600));
    const after = await host.fetchApi("/machine/resources", "viewer");
    assert.ok(after.body.sampleIntervalMs >= 1500); assert.ok(after.body.cpu.usagePercent >= 0 && after.body.cpu.usagePercent <= 100);
    assert.equal(after.body.sessions[0].sessionId, requestId); assert.equal(after.body.sessions[0].scope, "provider-process");
    assert.ok(after.body.sessions[0].rssBytes === null || after.body.sessions[0].rssBytes > 0);
    assert.equal((await host.fetchApi("/machine/resources", null)).status, 401);
    await host.stopApi(); await host.start();
    assert.equal((await host.fetchApi(`${upload}/commit`, "owner", {})).body.code, "session-running");
    assert.equal((await host.fetchApi(upload, "owner", undefined, {}, "DELETE")).status, 404, "restart expires staging handles");
  } finally { await host.stop(); }
});
