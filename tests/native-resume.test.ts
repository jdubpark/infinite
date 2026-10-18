import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { claimControl, startHost, waitFor } from "./helpers.js";

test("public native launches reject conversation selectors before spawning and allow prompt text", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-native-resume-"));
  const launchLog = join(root, "launches.jsonl");
  const fixture = join(root, "agent.mjs");
  writeFileSync(fixture, `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
setInterval(() => {}, 1000);
`);
  const profile = { command: process.execPath, args: [fixture] };
  const host = await startHost({ agents: { claude: profile, codex: profile, grok: profile, opencode: profile } });
  try {
    const selectors = [
      ["claude", ["--resume", "prior-session"]],
      ["claude", ["--continue"]],
      ["claude", ["-c"]],
      ["claude", ["--fork-session"]],
      ["claude", ["--from-pr", "123"]],
      ["claude", ["--teleport", "prior-session"]],
      ["claude", ["--cloud", "prior-session"]],
      ["claude", ["attach", "prior-session"]],
      ["claude", ["respawn", "prior-session"]],
      ["claude", ["-rprior-session"]],
      ["claude", ["-rtitle=old"]],
      ["claude", ["-crprior-session"]],
      ["claude", ["-p", "--resume", "prior-session"]],
      ["codex", ["resume", "prior-session"]],
      ["codex", ["fork", "prior-session"]],
      ["codex", ["queue", "prior-session", "message"]],
      ["codex", ["exec", "resume", "prior-session"]],
      ["codex", ["hello", "resume", "prior-session"]],
      ["codex", ["exec", "fork", "prior-session"]],
      ["codex", ["e", "resume", "prior-session"]],
      ["codex", ["-C", "/tmp", "resume", "prior-session"]],
      ["codex", ["exec", "--model", "gpt-6", "resume", "prior-session"]],
      ["codex", ["exec", "--color", "never", "resume", "prior-session"]],
      ["grok", ["--resume", "prior-session"]],
      ["grok", ["--continue"]],
      ["grok", ["--fork-session"]],
      ["grok", ["-rprior-session"]],
      ["grok", ["sessions", "search", "prior-session"]],
      ["grok", ["hello", "sessions", "list"]],
      ["grok", ["--cwd", "/tmp", "sessions", "list"]],
      ["opencode", ["--session", "prior-session"]],
      ["opencode", ["--continue"]],
      ["opencode", ["--fork"]],
      ["opencode", ["-sprior-session"]],
      ["opencode", ["attach", "http://127.0.0.1:4096"]],
      ["opencode", ["import", "prior-session.json"]],
      ["opencode", ["--model", "provider/model", "attach", "http://127.0.0.1:4096"]],
      ["opencode", ["--model", "provider/model", "import", "prior-session.json"]],
      ["opencode", ["--model", "--session", "prior-session"]],
    ];
    for (const [provider, nativeArgs] of selectors as [string, string[]][]) {
      const response = await host.fetchApi("/sessions", "owner", {
        requestId: randomUUID(), provider, projectId: "rehearsal", title: "Must remain fresh", nativeArgs,
      });
      assert.equal(response.status, 400, JSON.stringify({ nativeArgs, body: response.body }));
      assert.match(response.body.error, /infinite resume SESSION_ID/);
      assert.equal(existsSync(launchLog), false, "a rejected native continuation must not spawn a provider process");
      assert.equal((await host.fetchApi("/sessions")).body.sessions.length, 0);
    }

    const accepted = [];
    for (const [provider, nativeArgs] of [
      ["claude", ["--append-system-prompt", "Implement the resume command"]],
      ["claude", ["-p", "Implement the resume command"]],
      ["claude", ["--", "--resume"]],
      ["opencode", ["--model", "attach", "--prompt", "Implement the resume command"]],
      ["grok", ["-mgrok-code-fast-1", "Do work"]],
      ["grok", ["-pDescribe the problem"]],
    ]) {
      accepted.push(await host.fetchApi("/sessions", "owner", {
        requestId: randomUUID(), provider, projectId: "rehearsal", title: "Fresh prompt",
        nativeArgs,
      }));
    }
    assert.ok(accepted.every(response => response.status === 201), JSON.stringify(accepted.map(response => response.body)));
    await waitFor(() => existsSync(launchLog) && readFileSync(launchLog, "utf8").trim().split("\n").length === accepted.length, Boolean);
    const launches = readFileSync(launchLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(launches, [
      ["--append-system-prompt", "Implement the resume command"],
      ["-p", "Implement the resume command"],
      ["--", "--resume"],
      ["--model", "attach", "--prompt", "Implement the resume command"],
      ["-mgrok-code-fast-1", "Do work"],
      ["-pDescribe the problem"],
    ]);
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native resume refuses a live continuation bound to another project", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-resume-projects-"));
  const firstRoot = join(root, "first-project");
  const secondRoot = join(root, "second-project");
  mkdirSync(firstRoot); mkdirSync(secondRoot);
  const agent = join(root, "agent.mjs");
  const nativeId = randomUUID();
  writeFileSync(agent, `
if (process.env.INFINITE_HOOK_URL) await fetch(process.env.INFINITE_HOOK_URL + '/claude', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.INFINITE_HOOK_TOKEN },
  body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: ${JSON.stringify(nativeId)}, prompt: 'Native history fixture' })
});
setInterval(() => {}, 1000);
`);
  const host = await startHost({
    agents: { claude: { command: process.execPath, args: [agent] } },
    config: { projects: [
      { id: "first", name: "First", path: firstRoot },
      { id: "second", name: "Second", path: secondRoot },
    ] },
  });
  try {
    const sourceId = randomUUID();
    const source = await host.fetchApi("/sessions", "owner", {
      requestId: sourceId, provider: "claude", projectId: "first", title: "Original", prompt: "Original session",
    });
    assert.equal(source.status, 201);
    await waitFor(() => host.fetchApi(`/sessions/${sourceId}`), response => response.body.nativeSession?.id === nativeId);
    const sourceControl = await claimControl(host, sourceId, "owner");
    await host.fetchApi(`/sessions/${sourceId}/stop`, "owner", { requestId: randomUUID() }, sourceControl.headers);
    await waitFor(() => host.fetchApi(`/sessions/${sourceId}`), response => response.body.status === "exited");

    const key = readFileSync(host.config.keyFile);
    const updateSession = (id: string, update: (session: Record<string, any>) => void) => {
      const file = join(host.config.stateDir, "sessions", id, "meta.sealed");
      const scope = `${id}:meta`;
      const stored = unseal<{ session: Record<string, any> }>(key, scope, readFileSync(file, "utf8"));
      update(stored.session);
      writeSealed(file, key, scope, stored);
    };
    // Legacy source metadata has no projectRoot. Its root-level cwd is the only
    // safe proof that it still belongs to the current configured project.
    updateSession(sourceId, session => {
      delete session.projectRoot;
      session.resumeNativeSession = { id: nativeId, source: "hook" };
    });

    const continuationId = randomUUID();
    const continuation = await host.fetchApi("/sessions", "owner", {
      requestId: continuationId, provider: "claude", projectId: "second", title: "Other project", prompt: "Separate work",
    });
    assert.equal(continuation.status, 201);
    await waitFor(() => host.fetchApi(`/sessions/${continuationId}`), response => response.body.status === "running");
    updateSession(continuationId, session => { session.resumeNativeSession = { id: nativeId, source: "hook" }; });
    const liveCandidate = await host.fetchApi(`/sessions/${continuationId}`);
    assert.equal(liveCandidate.body.status, "running", JSON.stringify(liveCandidate.body));

    const refused = await host.fetchApi(`/sessions/${sourceId}/resume`, "owner", { requestId: randomUUID() });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /another project or codebase/);
    assert.equal((await host.fetchApi("/sessions")).body.sessions.length, 2, "a cross-project native match never starts another continuation");

    const receiptRequestId = randomUUID();
    writeSealed(join(host.config.stateDir, "resumptions", `${receiptRequestId}.sealed`), key,
      `resume:${receiptRequestId}`, { sourceId, targetId: continuationId });
    const cached = await host.fetchApi(`/sessions/${sourceId}/resume`, "owner", { requestId: receiptRequestId });
    assert.equal(cached.status, 409, JSON.stringify(cached.body));
    assert.match(cached.body.error, /receipt belongs to another project or codebase/);
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
