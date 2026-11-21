import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
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

test("owner resume keeps the native conversation's recorded Code Mode after config changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-code-mode-resume-"));
  const launchLog = join(root, "launches.jsonl");
  const fixture = join(root, "agent.mjs");
  const nativeIds = [randomUUID(), randomUUID(), randomUUID()];
  writeFileSync(fixture, `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const resume = args.indexOf('--resume');
const prompt = args.find(value => value.startsWith('native:'));
const nativeId = resume >= 0 ? args[resume + 1] : prompt?.slice('native:'.length);
appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ mode: process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE, nativeId }) + '\\n');
if (process.env.INFINITE_HOOK_URL) await fetch(process.env.INFINITE_HOOK_URL + '/claude', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.INFINITE_HOOK_TOKEN },
  body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: nativeId, prompt: 'Resume fixture' })
});
setInterval(() => {}, 1000);
`);
  const host = await startHost({ agents: { claude: { command: process.execPath, args: [fixture] } }, config: { codeMode: { claude: "all" } } });
  const readLaunches = () => readFileSync(launchLog, "utf8").trim().split("\n").map(line => JSON.parse(line) as { mode?: string; nativeId: string });
  const start = async (nativeId: string) => {
    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", { requestId: id, projectId: "rehearsal", provider: "claude", title: "Code Mode", prompt: `native:${nativeId}` });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(Object.hasOwn(created.body, "codeMode"), false, "creation responses keep the host choice internal");
    await waitFor(() => host.fetchApi(`/sessions/${id}`), response => response.body.nativeSession?.id === nativeId);
    return id;
  };
  const stop = async (id: string) => {
    const control = await claimControl(host, id, "owner");
    await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() }, control.headers);
    await waitFor(() => host.fetchApi(`/sessions/${id}`), response => response.body.status === "exited");
  };
  const setModeAndRestartApi = async (claude: "off" | "all") => {
    host.config.codeMode = { claude };
    writeFileSync(join(host.root, "config.json"), JSON.stringify(host.config));
    await host.stopApi();
    await host.start();
  };
  try {
    const enabled = await start(nativeIds[0]!);
    assert.equal(Object.hasOwn((await host.fetchApi(`/sessions/${enabled}`)).body, "codeMode"), false);
    const listed = await host.fetchApi("/sessions");
    const sessionRows = (listed.body as { sessions: Record<string, unknown>[] }).sessions;
    assert.equal(Object.hasOwn(sessionRows.find(row => row.id === enabled)!, "codeMode"), false, "listing rows keep the host choice internal");
    await stop(enabled);
    await setModeAndRestartApi("off");
    const enabledResume = await host.fetchApi(`/sessions/${enabled}/resume`, "owner", { requestId: randomUUID() });
    assert.equal(enabledResume.status, 200, JSON.stringify(enabledResume.body));
    assert.equal(Object.hasOwn(enabledResume.body, "codeMode"), false, "resume responses keep the host choice internal");
    await waitFor(() => readLaunches(), launches => launches.length === 2);
    assert.equal(readLaunches()[1]!.mode, "1");

    const disabled = await start(nativeIds[1]!);
    assert.equal(Object.hasOwn((await host.fetchApi(`/sessions/${disabled}`)).body, "codeMode"), false);
    await stop(disabled);
    await setModeAndRestartApi("all");
    const disabledResume = await host.fetchApi(`/sessions/${disabled}/resume`, "owner", { requestId: randomUUID() });
    assert.equal(disabledResume.status, 200, JSON.stringify(disabledResume.body));
    await waitFor(() => readLaunches(), launches => launches.length === 4);
    assert.equal(Object.hasOwn(readLaunches()[3]!, "mode"), false);

    // A plain conversation's resume request is the one the host built before the switch existed. So a resume that an
    // earlier host had started, with the record written and the receipt not yet, is found again by its fingerprint.
    const key = readFileSync(host.config.keyFile);
    const record = (id: string) => unseal<{ session: Record<string, any>; fingerprint: string }>(key, `${id}:meta`,
      readFileSync(join(host.config.stateDir, "sessions", id, "meta.sealed"), "utf8"));
    const plain = disabledResume.body.id as string;
    const earlierRequest = { requestId: plain, provider: "claude", projectId: "rehearsal", title: "Code Mode", prompt: "",
      nativeArgs: ["--resume", nativeIds[1]], resumedFrom: disabled, resumeNativeSession: record(plain).session.resumeNativeSession };
    assert.equal(record(plain).fingerprint, createHash("sha256").update(JSON.stringify(earlierRequest)).digest("hex"));
    assert.equal(record(plain).session.codeMode, false);
    rmSync(join(host.config.stateDir, "resumptions", `${plain}.sealed`));
    const retried = await host.fetchApi(`/sessions/${disabled}/resume`, "owner", { requestId: plain });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.id, plain);
    assert.equal(readLaunches().length, 4, "the retry starts nothing");

    // A headless run takes Code Mode only from its --settings argument, and an owner resume has no permission channel
    // to carry one. So a recorded Code Mode conversation resumed through a headless profile starts without the
    // variable, and its record says so.
    const recorded = await start(nativeIds[2]!);
    assert.equal(readLaunches()[4]!.mode, "1");
    await stop(recorded);
    host.config.agents = { claude: { command: process.execPath, args: [fixture, "-p"] } };
    await setModeAndRestartApi("all");
    const headlessResume = await host.fetchApi(`/sessions/${recorded}/resume`, "owner", { requestId: randomUUID() });
    assert.equal(headlessResume.status, 200, JSON.stringify(headlessResume.body));
    await waitFor(() => readLaunches(), launches => launches.length === 6);
    assert.equal(readLaunches()[5]!.nativeId, nativeIds[2]);
    assert.equal(Object.hasOwn(readLaunches()[5]!, "mode"), false);
    assert.equal(record(headlessResume.body.id as string).session.codeMode, false);
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
