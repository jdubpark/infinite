import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startHost, type Host } from "./helpers.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { PermissionJournal, permissionJournalModule, type PermissionDecision } from "../packages/host/src/evidence/permission-journal.js";

const exec = promisify(execFile);
const ASSIGNMENT = "task-1:builder";

/** An original effect reject and two repeats of it from one assignment: the assignment is locked. */
function seedLockedAssignment(host: Host) {
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(host.config.stateDir), vaultKey: readFileSync(host.config.keyFile) });
  try {
    store.register(permissionJournalModule);
    const journal = new PermissionJournal(store);
    const reject = (id: string, minute: number, repeats?: string, taskId = "task-1"): PermissionDecision => ({
      id, at: `2026-11-14T12:0${minute}:00.000Z`, workspaceId: "rehearsal", projectId: "rehearsal", taskId,
      assignment: `${taskId}:builder`, sessionId: "session-1", provider: "provider-a", family: "alpha", evidenceHash: `evidence-${id}`,
      action: { tool: "Bash", summary: `attempt ${minute}` }, rules: [],
      tiers: [{ tier: "strong", profileId: "strong-gamma", family: "gamma", startedAt: "2026-11-14T12:00:00.000Z", endedAt: "2026-11-14T12:00:01.000Z" }],
      verdict: "reject", code: "unsafe", ...(repeats === undefined ? {} : { repeats }),
    });
    journal.appendDecision(reject("decision-original", 1));
    journal.appendDecision(reject("decision-repeat-1", 2, "decision-original"));
    journal.appendDecision(reject("decision-repeat-2", 3, "decision-original"));
    journal.appendDecision(reject("decision-other-task", 4, undefined, "task-2"));
    assert.equal(journal.isLocked(ASSIGNMENT), true);
  } finally {
    store.close();
  }
}

test("owner CLI reopens a reject and unlocks an assignment; nobody else can", { timeout: 120000 }, async () => {
  let host: Host | undefined;
  try {
    host = await startHost();
    await host.stopApi();
    seedLockedAssignment(host);
    await host.start();

    const unlock = { requestId: randomUUID(), assignment: ASSIGNMENT };
    const reopen = { requestId: randomUUID(), decisionId: "decision-repeat-1" };
    for (const [path, body] of [["/permissions/unlocks", unlock], ["/permissions/reopenings", reopen]] as const) {
      assert.equal((await host.fetchApi(path, "controller", body)).status, 403);
      assert.equal((await host.fetchApi(path, "viewer", body)).status, 403);
      assert.ok([401, 403].includes((await host.fetchApi(path, null, body)).status), "an anonymous caller is refused");
    }
    const login = await fetch(`${host.origin}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: host.origin }, body: JSON.stringify({ token: host.tokens.owner }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const browser = await fetch(`${host.origin}/api/permissions/unlocks`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: host.origin }, body: JSON.stringify(unlock),
    });
    assert.equal(browser.status, 403, "an owner browser session without the CLI bearer cannot unlock");
    assert.equal((await host.fetchApi("/permissions/unlocks", "owner", { requestId: "not-a-uuid", assignment: ASSIGNMENT })).status, 400);

    const clientFile = join(host.root, "permissions-client.json");
    writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
    const cli = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
    const permissions = (...args: string[]) => exec(cli[0], [...cli.slice(1), "permissions", ...args]);

    await assert.rejects(permissions("reopen"), (error: { stderr: string }) => /Usage: infinite permissions reopen/.test(error.stderr));
    await assert.rejects(permissions("reopen", "decision-missing"), (error: { stderr: string }) => /HTTP 404 \(permission-decision-not-found\)/.test(error.stderr));

    const unlocked = JSON.parse((await permissions("unlock", ASSIGNMENT, "--request-id", unlock.requestId, "--json")).stdout);
    assert.deepEqual(unlocked, { assignment: ASSIGNMENT, wasLocked: true, locked: false });
    // A retry with the same request ID returns the recorded result; the same ID for another act is a conflict.
    assert.deepEqual((await host.fetchApi("/permissions/unlocks", "owner", unlock)).body, unlocked);
    assert.equal((await host.fetchApi("/permissions/reopenings", "owner", { ...reopen, requestId: unlock.requestId })).status, 409);

    const reopened = await permissions("reopen", "decision-repeat-1");
    assert.match(reopened.stdout, /^Reopened reject decision-original \(unsafe\)\. .*Nothing was allowed\.$/m);

    // The delegation route closes open rejects when the owner changes the direction text.
    const workspaceId = (await host.fetchApi("/project-groups/rehearsal", "owner")).body.id as string;
    for (const direction of ["Run checks.", "Run only the focused checks."]) {
      const delegated = await host.fetchApi("/permissions/delegations", "owner", { requestId: randomUUID(), workspaceId, direction });
      assert.equal(delegated.status, 200, JSON.stringify(delegated.body));
    }

    await host.stopApi();
    const store = new EvidenceStore({ databasePath: evidenceDatabasePath(host.config.stateDir), vaultKey: readFileSync(host.config.keyFile) });
    try {
      store.register(permissionJournalModule);
      const journal = new PermissionJournal(store);
      assert.deepEqual(journal.openRejects("task-1"), [], "reopening a repeat closes the reject it repeats");
      assert.deepEqual(journal.openRejects("task-2"), [], "a changed direction text closes the project's open rejects");
      assert.equal(journal.isLocked(ASSIGNMENT), false);
      assert.deepEqual(journal.decisions({ verdict: "allow" }), [], "neither control records an allow");
    } finally {
      store.close();
    }
  } finally {
    if (host) await host.stop();
  }
});
