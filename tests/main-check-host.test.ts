import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordDirectory, recordScope } from "../packages/host/src/main-check-ports.js";
import type { MainCheckRecord } from "../packages/host/src/main-check-state.js";
import { Notifier } from "../packages/host/src/notifier.js";
import type { PushMessage, PushTicket } from "../packages/host/src/push.js";
import type { TeamCommand } from "../packages/host/src/team-types.js";
import { unseal } from "../packages/host/src/vault.js";
import { inProcessHost, waitFor, type ApiResponse } from "./helpers.js";
import { earlierProcesses } from "./main-check-earlier.js";
import { git } from "./team-fixture.js";

const PROJECT = "alpha";
const WAIT_MS = 20_000;
const CASE = { timeout: 60_000 };
const UNINSPECTED = (await earlierProcesses()).size;
const REMOVES_A_COPY = UNINSPECTED === 0 ? CASE : { ...CASE, skip: `this account has ${UNINSPECTED} process(es) the census cannot inspect, so a main check here removes no copy while they run (docs/teams.md, Main check, limits)` };
const COMMIT = ["-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "commit", "-q", "-m"];
const sh = (script: string): TeamCommand => ({ command: "sh", args: ["-c", script] });

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function mainCheckHost(files: Record<string, string>, checks: (root: string) => TeamCommand[]) {
  let source = "";
  let remote = "";
  const host = await inProcessHost({
    configure: config => {
      const root = dirname(config.stateDir);
      source = join(root, "source");
      remote = join(root, "remote.git");
      const checkout = join(root, "checkout");
      mkdirSync(source);
      git(source, "init", "-q", "--initial-branch=main");
      for (const [name, text] of Object.entries(files)) writeFileSync(join(source, name), text);
      git(source, "add", "-A");
      git(source, ...COMMIT, "first");
      git(root, "clone", "-q", "--bare", source, remote);
      git(root, "clone", "-q", remote, checkout);
      config.projects = [{
        id: PROJECT, name: "Alpha", path: checkout,
        source: { mode: "github", repository: "example/alpha", baseBranch: "main" },
        team: { checks: checks(root), mainCheck: { minutes: 1 } },
      }];
      config.source = { remoteOverrides: { [PROJECT]: remote } };
      config.teams = { workspaceDir: join(root, "teams"), storageFloor: { inodes: 0, bytes: 0 } };
      config.push = { enabled: true, endpoint: "https://push.example.invalid/send", detail: "minimal", events: ["main-check"] };
    },
  });
  const root = host.root;
  const key = readFileSync(host.config.keyFile);
  return {
    host,
    root,
    teams: join(root, "teams"),
    head: () => git(source, "rev-parse", "HEAD"),
    push(change: () => void) {
      change();
      git(source, "add", "-A");
      git(source, ...COMMIT, "next");
      git(source, "push", "-q", remote, "HEAD:refs/heads/main");
    },
    async refresh() {
      const response = await host.fetchApi(`/projects/${PROJECT}/source/refresh`, "owner", {});
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body as { mirrorHead?: string };
    },
    read: (role: "owner" | "controller" | "viewer" = "owner", projectId = PROJECT) => host.fetchApi(`/projects/${projectId}/main-check`, role),
    until: (what: string, accepts: (response: ApiResponse) => boolean) =>
      waitFor(() => host.fetchApi(`/projects/${PROJECT}/main-check`, "owner"), accepts, WAIT_MS).catch(error => assert.fail(`${what}: ${(error as Error).message}`)),
    record: (): MainCheckRecord => unseal<MainCheckRecord>(key, recordScope(PROJECT), readFileSync(join(recordDirectory(host.config), `${PROJECT}.sealed`), "utf8")),
  };
}

test("a mirror fetch reaches the main check through onMirror, and the owner's read shows the result without host paths", CASE, async () => {
  const release = (root: string) => join(root, "release");
  const h = await mainCheckHost({ "tracked.txt": "one\n" }, root => [sh(`while [ ! -f '${release(root)}' ]; do sleep 0.1; done`)]);
  try {
    const head = h.head();
    assert.equal((await h.refresh()).mirrorHead, head);
    const running = await h.until("the check starts", response => response.body.running?.head === head);
    const entry = h.record().running!;
    const text = JSON.stringify(running.body);
    for (const secret of [entry.directory, entry.root, h.teams, entry.witness.boot, "witness", "recording"]) assert.equal(text.includes(secret), false, `the owner's read shows ${secret}`);
    writeFileSync(release(h.root), "go\n");
    const done = await h.until("the result", response => response.body.results?.length === 1);
    assert.equal(done.body.readable, true);
    assert.equal(done.body.enabled, true);
    assert.equal(done.body.runnable, true);
    assert.equal(done.body.health?.head, head);
    assert.equal(done.body.health?.outcome, "passed");
    assert.equal(done.body.current, true);
    for (const role of ["viewer", "controller"] as const) {
      const refused = await h.read(role);
      assert.equal(refused.status, 403, `${role}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.health, undefined);
    }
    assert.equal((await h.read("owner", "nope")).status, 404);
  } finally {
    await h.host.stop();
  }
});

test("a real Notifier tells the owner main is failing, then that it passes again, and a push that reached nobody changes nothing", REMOVES_A_COPY, async () => {
  const h = await mainCheckHost({ "tracked.txt": "one\n", broken: "yes\n" }, () => [sh("if [ -f broken ]; then echo 'not ok 1 - the build is broken' >&2; exit 3; fi")]);
  try {
    const registered = await h.host.fetchApi("/devices/push", "owner", { token: "ExponentPushToken[mainCheckDevice01]", platform: "ios" });
    assert.deepEqual([registered.status, registered.body], [200, { ok: true, push: true }]);
    let tickets: "ok" | "error" = "ok";
    const sent: PushMessage[][] = [];
    const sender = async (messages: PushMessage[]): Promise<PushTicket[]> => {
      sent.push(messages);
      return messages.map(() => tickets === "ok" ? { status: "ok", id: "ticket" } : { status: "error", message: "refused", details: { error: "MessageRateExceeded" } });
    };
    const { sessions, pushStore, teams, goals, fuse, permissions, mainCheck } = h.host;
    const push = h.host.config.push!;
    const notifier = new Notifier(sessions, pushStore, sender, { detail: push.detail, events: push.events, intervalMs: 2000, machineId: h.host.config.machine?.id }, teams, goals, { sample: async () => [] }, fuse, permissions, mainCheck);
    const first = h.head();
    await h.refresh();
    await h.until("the failed result", response => response.body.results?.length === 1);
    await notifier.tick();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.map(message => [message.to, message.title, message.body]), [["ExponentPushToken[mainCheckDevice01]", "Main is failing", `Alpha: check 1 of 1 exited 3 at ${first.slice(0, 7)}.`]]);
    assert.deepEqual((await h.read()).body.told, { notice: 1, outcome: "failed" });
    await notifier.tick();
    assert.equal(sent.length, 1, "the owner was told; nothing is due");

    h.push(() => unlinkSync(join(dirname(h.host.config.stateDir), "source", "broken")));
    const fixed = h.head();
    await h.refresh();
    await h.until("the passed result", response => response.body.results?.length === 2 && response.body.health?.outcome === "passed");
    tickets = "error";
    await notifier.tick();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1]!.map(message => [message.title, message.body]), [["Main passes again", `Alpha: all 1 checks passed at ${fixed.slice(0, 7)}.`]]);
    assert.deepEqual((await h.read()).body.told, { notice: 1, outcome: "failed" }, "a push that reached no device is not what the owner was told");
    await notifier.tick();
    assert.equal(sent.length, 2, "the notice waits out its minute in flight instead of repeating on every tick");
    assert.equal(pushStore.list().length, 1, "a refused ticket that is not DeviceNotRegistered keeps the device");
  } finally {
    await h.host.stop();
  }
});

test("closeConnections resolves only after the main check closed: a real sleep is recorded as interrupted by the host stop", CASE, async () => {
  const pidFile = (root: string) => join(root, "pid");
  const h = await mainCheckHost({ "tracked.txt": "one\n" }, root => [sh(`echo $$ > '${pidFile(root)}'; exec sleep 30`)]);
  let pid: number | undefined;
  try {
    await h.refresh();
    await waitFor(async () => existsSync(pidFile(h.root)) && readFileSync(pidFile(h.root), "utf8").trim() !== "", ready => ready, WAIT_MS);
    pid = Number.parseInt(readFileSync(pidFile(h.root), "utf8"), 10);
    assert.equal(h.record().running?.head, h.head());
    assert.equal(gone(pid), false, "the sleep runs");
    await h.host.closeConnections();
    const record = h.record();
    assert.equal(record.running, undefined);
    assert.equal(record.last?.outcome, "interrupted");
    assert.equal(record.last?.reason, "host-stop");
    assert.equal(record.attempts, undefined, "a host stop gives the admission back");
    assert.equal(gone(pid), true, "the sleep was ended with its check");
  } finally {
    if (pid !== undefined && !gone(pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch { }
    }
    await new Promise<void>(resolve => h.host.server.close(() => resolve()));
    rmSync(h.root, { recursive: true, force: true });
  }
});
