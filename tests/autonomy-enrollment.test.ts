import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "../packages/host/src/types.js";
import { RepoEnrollmentService } from "../packages/host/src/repo-enrollment.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { startHost } from "./helpers.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// The host resolves its own zod copy, so match the error by name.
const zodError = (error: { name?: string }) => error.name === "ZodError";
const team = () => ({ checks: [{ command: "node", args: ["-e", "0"] }], handoff: "auto" as const });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "infinite-autonomy-enrollment-"));
  const projectPath = join(root, "project");
  const stateDir = join(root, "state");
  const runDir = join(root, "runs");
  const prefixReceipts = join(root, "prefix-receipts");
  mkdirSync(projectPath); mkdirSync(stateDir); mkdirSync(runDir); mkdirSync(prefixReceipts);
  git(projectPath, "init", "--initial-branch=main");
  writeFileSync(join(projectPath, "tracked.txt"), "committed\n");
  git(projectPath, "add", "tracked.txt");
  git(projectPath, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture");
  const project = { id: "example", name: "Example", path: projectPath };
  const config = (): Config => ({
    port: 0, origin: "http://localhost", stateDir, runDir, keyFile: join(root, "key"), tokens: [],
    projects: [structuredClone(project)], agents: {}, environment: "cloud", enableDemo: false, maxSessions: 1,
    teams: { workspaceDir: join(root, "team-workspaces"), commandPrefix: { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/team-agent.mjs"), "--command-prefix", prefixReceipts] } },
  });
  const key = randomBytes(32);
  const file = join(stateDir, "repo-enrollments.sealed");
  const receiptLines = () => existsSync(join(prefixReceipts, "commands.jsonl")) ? readFileSync(join(prefixReceipts, "commands.jsonl"), "utf8").trim().split("\n").length : 0;
  return { root, projectPath, file, config, key, receiptLines, close: () => rmSync(root, { recursive: true, force: true }) };
}

const enrollRequest = (revision: number, extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), revision, team: team(), ...extra });

test("an enrolled repository is autonomous by default and an unenrolled one is supervised", async () => {
  const f = fixture();
  try {
    const config = f.config();
    const service = new RepoEnrollmentService(config, f.key);
    const before = service.get("example");
    assert.equal(before.autonomy, "supervised");
    assert.equal(before.autonomySource, "not-enrolled");
    assert.equal(config.projects[0].autonomy, undefined);

    const saved = await service.put("example", enrollRequest(0));
    assert.equal(saved.autonomy, "autonomous");
    assert.equal(saved.autonomySource, "host-default");
    assert.equal(config.projects[0].autonomy, "autonomous");
    const stored = unseal<{ projects: Record<string, object> }>(f.key, "repo-enrollments", readFileSync(f.file, "utf8"));
    assert.equal(Object.hasOwn(stored.projects.example, "autonomy"), false, "the default is not written to the record");
  } finally { f.close(); }

  const g = fixture();
  try {
    const config = g.config();
    config.autonomy = { defaultMode: "supervised" };
    const saved = await new RepoEnrollmentService(config, g.key).put("example", enrollRequest(0));
    assert.equal(saved.autonomy, "supervised");
    assert.equal(saved.autonomySource, "host-default");
    assert.equal(config.projects[0].autonomy, "supervised");
  } finally { g.close(); }
});

test("an enrollment saved before this slice reads the host default and is not rewritten", () => {
  const f = fixture();
  try {
    const seeded = { version: 1, projects: { example: { path: realpathSync(f.projectPath), team: team(), revision: 1 } }, requests: {} };
    writeSealed(f.file, f.key, "repo-enrollments", seeded);
    const before = readFileSync(f.file);
    const config = f.config();
    const service = new RepoEnrollmentService(config, f.key);
    assert.equal(config.projects[0].autonomy, "autonomous");
    const view = service.get("example");
    assert.equal(view.autonomy, "autonomous");
    assert.equal(view.autonomySource, "host-default");
    assert.deepEqual(readFileSync(f.file), before, "loading and reading rewrite no record");
  } finally { f.close(); }
});

test("repo init stores an explicit mode outside the team block and keeps it when omitted", async () => {
  const f = fixture();
  try {
    const config = f.config();
    const service = new RepoEnrollmentService(config, f.key);
    const request = enrollRequest(0, { autonomy: "supervised" });
    const first = await service.put("example", request);
    assert.equal(first.autonomy, "supervised");
    assert.equal(first.autonomySource, "saved");

    const kept = await service.put("example", enrollRequest(1));
    assert.equal(kept.autonomy, "supervised");
    assert.equal(kept.autonomySource, "saved");

    const auto = await service.put("example", enrollRequest(2, { autonomy: "autonomous" }));
    assert.equal(auto.autonomy, "autonomous");
    assert.equal(Object.hasOwn(config.projects[0].team!, "autonomy"), false);
    const stored = unseal<{ projects: Record<string, { team: unknown }> }>(f.key, "repo-enrollments", readFileSync(f.file, "utf8"));
    assert.deepEqual(stored.projects.example.team, auto.team);
  } finally { f.close(); }
});

test("a mode change is one revision, replays by request id, and runs no Git", async () => {
  const f = fixture();
  try {
    const config = f.config();
    const service = new RepoEnrollmentService(config, f.key);
    await service.put("example", enrollRequest(0));
    const id = randomUUID();
    const change = { requestId: id, revision: 1, mode: "supervised" as const };
    const receiptsBefore = f.receiptLines();
    const changed = await service.setAutonomy("example", change);
    assert.equal(changed.revision, 2);
    assert.equal(changed.autonomy, "supervised");
    assert.equal(changed.autonomySource, "saved");
    assert.equal(config.projects[0].autonomy, "supervised");
    assert.equal(f.receiptLines(), receiptsBefore, "a mode change runs no Git command");

    assert.deepEqual(await service.setAutonomy("example", change), changed, "the same request replays its stored view");
    await assert.rejects(service.setAutonomy("example", { ...change, mode: "autonomous" }), (error: { code?: string }) => error.code === "request-conflict");
    await assert.rejects(service.setAutonomy("example", { requestId: randomUUID(), revision: 1, mode: "autonomous" }), (error: { code?: string }) => error.code === "stale-enrollment-revision");

    const busy = new RepoEnrollmentService(f.config(), f.key, { isBusy: () => true });
    const accepted = await busy.setAutonomy("example", { requestId: randomUUID(), revision: 2, mode: "autonomous" });
    assert.equal(accepted.revision, 3);
    assert.equal(accepted.autonomy, "autonomous");
  } finally { f.close(); }
});

test("a mode change needs an applied enrollment", async () => {
  const f = fixture();
  try {
    const config = f.config();
    const service = new RepoEnrollmentService(config, f.key);
    await assert.rejects(service.setAutonomy("example", { requestId: randomUUID(), revision: 1, mode: "supervised" }), (error: { code?: string; status?: number }) => error.code === "autonomy-requires-enrollment" && error.status === 409);
    assert.equal(existsSync(f.file), false, "nothing is sealed for an unenrolled repository");
    await assert.rejects(service.setAutonomy("missing", { requestId: randomUUID(), revision: 1, mode: "supervised" }), (error: { code?: string; status?: number }) => error.code === "unknown-project" && error.status === 404);

    await service.put("example", enrollRequest(0));
    const movedPath = join(f.root, "moved-project"); mkdirSync(movedPath);
    const moved = f.config(); moved.projects[0].path = movedPath;
    await assert.rejects(new RepoEnrollmentService(moved, f.key).setAutonomy("example", { requestId: randomUUID(), revision: 1, mode: "supervised" }), (error: { code?: string }) => error.code === "project-path-mismatch");
  } finally { f.close(); }
});

test("a record that start-up did not apply cannot change its mode", async () => {
  const f = fixture();
  try {
    await new RepoEnrollmentService(f.config(), f.key).put("example", enrollRequest(0));
    // restore skips a record whose saved teamwork folder no longer resolves; get() still reads it.
    writeSealed(f.file, f.key, "repo-enrollments", {
      version: 1,
      projects: { example: { path: realpathSync(f.projectPath), team: team(), revision: 1, teamwork: "../escape" } },
      requests: {},
    });
    const sealedBefore = readFileSync(f.file);
    const config = f.config();
    const service = new RepoEnrollmentService(config, f.key);
    assert.equal(config.projects[0].autonomy, undefined, "start-up did not apply the record");
    const view = service.get("example");
    assert.equal(view.autonomy, "supervised");
    assert.equal(view.autonomySource, "not-enrolled");

    await assert.rejects(service.setAutonomy("example", { requestId: randomUUID(), revision: 1, mode: "autonomous" }), (error: { code?: string; status?: number }) => error.code === "autonomy-requires-enrollment" && error.status === 409);
    assert.deepEqual(readFileSync(f.file), sealedBefore, "nothing is sealed");
    assert.equal(config.projects[0].autonomy, undefined, "the overlay stays absent");
    assert.equal(service.get("example").autonomy, "supervised");
    assert.equal(service.get("example").revision, 1);

    const reenrolled = await service.put("example", { requestId: randomUUID(), revision: 1, team: team(), teamwork: null });
    assert.equal(reenrolled.revision, 2);
    const changed = await service.setAutonomy("example", { requestId: randomUUID(), revision: 2, mode: "autonomous" });
    assert.equal(changed.autonomy, "autonomous");
    assert.equal(changed.autonomySource, "saved");
  } finally { f.close(); }
});

test("a mode change survives a restart", async () => {
  const f = fixture();
  try {
    const service = new RepoEnrollmentService(f.config(), f.key);
    await service.put("example", enrollRequest(0));
    await service.setAutonomy("example", { requestId: randomUUID(), revision: 1, mode: "supervised" });
    const config = f.config();
    const restarted = new RepoEnrollmentService(config, f.key);
    assert.equal(config.projects[0].autonomy, "supervised");
    assert.equal(restarted.get("example").autonomy, "supervised");
    assert.equal(restarted.get("example").autonomySource, "saved");
  } finally { f.close(); }
});

test("an unknown mode is refused and a stored unknown mode reads as supervised", async () => {
  const f = fixture();
  try {
    const service = new RepoEnrollmentService(f.config(), f.key);
    await service.put("example", enrollRequest(0));
    await assert.rejects(service.setAutonomy("example", { requestId: randomUUID(), revision: 1, mode: "auto" as never }), zodError);
    await assert.rejects(service.put("example", enrollRequest(1, { autonomy: "auto" })), zodError);
    assert.equal(service.get("example").revision, 1, "the revision is unchanged");

    writeSealed(f.file, f.key, "repo-enrollments", {
      version: 1,
      projects: { example: { path: realpathSync(f.projectPath), team: team(), revision: 1, autonomy: "auto" } },
      requests: {},
    });
    const config = f.config();
    const reread = new RepoEnrollmentService(config, f.key);
    assert.equal(config.projects[0].autonomy, "supervised");
    assert.equal(reread.get("example").autonomy, "supervised");
    assert.equal(reread.get("example").autonomySource, "saved");
  } finally { f.close(); }
});

test("only the owner CLI changes the mode over the API", { timeout: 45000 }, async () => {
  const external = mkdtempSync(join(tmpdir(), "infinite-autonomy-route-"));
  const homeDir = join(external, "home");
  const teamWorkspace = join(external, "team-workspaces");
  mkdirSync(homeDir); mkdirSync(teamWorkspace);
  const host = await startHost({ config: { sync: { homeDir, sharedGroup: true }, teams: { workspaceDir: teamWorkspace } } });
  try {
    const mapped = await host.fetchApi("/projects/resolve", "owner", { path: "Projects/sample" });
    assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
    const projectPath = mapped.body.path as string;
    git(projectPath, "init", "--initial-branch=main");
    writeFileSync(join(projectPath, "tracked.txt"), "committed\n");
    git(projectPath, "add", "tracked.txt");
    git(projectPath, "-c", "user.name=Example", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture");

    const teamEndpoint = `/projects/${mapped.body.id}/team`;
    const autonomyEndpoint = `/projects/${mapped.body.id}/autonomy`;
    const enrolled = await host.fetchApi(teamEndpoint, "owner", { requestId: randomUUID(), revision: 0, team: { checks: [{ command: "node", args: ["-e", "0"] }], handoff: "off" }, linear: null }, {}, "PUT");
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
    assert.equal(enrolled.body.autonomy, "autonomous");
    assert.equal(enrolled.body.autonomySource, "host-default");

    const request = { requestId: randomUUID(), revision: 1, mode: "supervised" };
    const changed = await host.fetchApi(autonomyEndpoint, "owner", request, {}, "PUT");
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.autonomy, "supervised");
    assert.equal(changed.body.autonomySource, "saved");
    assert.equal(changed.body.revision, 2);

    assert.equal((await host.fetchApi(autonomyEndpoint, "controller", { ...request, requestId: randomUUID(), revision: 2 }, {}, "PUT")).status, 403);
    assert.equal((await host.fetchApi(autonomyEndpoint, "viewer", { ...request, requestId: randomUUID(), revision: 2 }, {}, "PUT")).status, 403);
    const login = await host.fetchApi("/login", null, { token: host.tokens.owner }, { Origin: host.config.origin });
    assert.equal(login.status, 200);
    const browser = { Cookie: login.headers.get("set-cookie")!.split(";")[0], Origin: host.config.origin };
    assert.equal((await host.fetchApi(autonomyEndpoint, null, { ...request, requestId: randomUUID(), revision: 2 }, browser, "PUT")).status, 403);
    assert.equal((await host.fetchApi(autonomyEndpoint, "owner", { ...request, requestId: randomUUID(), revision: 2, mode: "auto" }, {}, "PUT")).status, 400);
    assert.equal((await host.fetchApi(autonomyEndpoint, "owner", { ...request, requestId: randomUUID(), revision: 2, extra: true }, {}, "PUT")).status, 400);

    const me = await host.fetchApi("/me");
    assert.equal(me.body.teams.autonomyMode, 1);

    await host.stopApi();
    await host.start();
    const afterRestart = await host.fetchApi(teamEndpoint);
    assert.equal(afterRestart.status, 200, JSON.stringify(afterRestart.body));
    assert.equal(afterRestart.body.autonomy, "supervised");
    assert.equal(afterRestart.body.autonomySource, "saved");
    assert.equal(afterRestart.body.revision, 2);
    assert.equal(statSync(projectPath).isDirectory(), true);
  } finally { await host.stop(); rmSync(external, { recursive: true, force: true }); }
});
