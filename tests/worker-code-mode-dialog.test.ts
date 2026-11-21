import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { claimControl, startHost, waitFor, type Host } from "./helpers.js";

const attention = { idleAfterMs: 3000, limitConfirmMs: 3000, hooks: { claude: false, codex: false } };

test("an old Code Mode menu above a live yes-no prompt: the owner's No sends n, never a bare Enter", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "code-mode-yes-no-"));
  const answerFile = join(directory, "answer.txt");
  const envFile = join(directory, "agent.env");
  writeFileSync(envFile, ["CODE_MODE_DIALOG_OLD_COPY=1", "CODE_MODE_DIALOG_LIVE=yes-no", `CODE_MODE_DIALOG_ANSWER_FILE=\"${answerFile}\"`].join("\n"));
  const fixture = fileURLToPath(new URL("./fixtures/code-mode-dialog-agent.mjs", import.meta.url));
  let host: Host | undefined;
  try {
    const runningHost = await startHost({
      agents: { claude: { command: process.execPath, args: [`--env-file=${envFile}`, fixture] } },
      config: { attention },
    });
    host = runningHost;
    const id = randomUUID();
    const created = await runningHost.fetchApi("/sessions", "owner", {
      requestId: id, provider: "claude", projectId: "rehearsal", title: "Yes or no", prompt: "Start the session",
    });
    assert.equal(created.status, 201);
    // The old menu's cursor is on No. Read as the open prompt, a "No" answer would be a bare Enter: the default, Yes.
    const open = await waitFor(() => runningHost.fetchApi(`/sessions/${id}`), response =>
      response.body.attention?.state === "needs-you" && Boolean(response.body.attention.prompt), 15000);
    const prompt = open.body.attention.prompt;
    assert.equal(prompt.kind, "yes-no");
    assert.equal(prompt.title, "Press y to proceed or n to cancel [Y/n]");
    const no = prompt.options.find((option: { role: string }) => option.role === "reject");
    assert.ok(no);

    const owner = await claimControl(runningHost, id, "owner");
    const answer = await runningHost.fetchApi(`/sessions/${id}/answer`, "owner", {
      requestId: randomUUID(), promptId: prompt.id, option: no.index,
    }, owner.headers);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const keys = await waitFor(async () => existsSync(answerFile) ? readFileSync(answerFile, "utf8") : "", value => value.length > 0, 10000);
    assert.equal(JSON.parse(keys), "n\r");
  } finally {
    if (host) await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the owner rejects the live Code Mode option despite a stale menu above it", { timeout: 60000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "code-mode-dialog-"));
  const answerFile = join(directory, "answer.txt");
  const envFile = join(directory, "agent.env");
  writeFileSync(envFile, [
    "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1",
    "CODE_MODE_DIALOG_INITIAL=Yes",
    "CODE_MODE_DIALOG_OLD_COPY=1",
    `CODE_MODE_DIALOG_ANSWER_FILE=\"${answerFile}\"`,
  ].join("\n"));
  const fixture = fileURLToPath(new URL("./fixtures/code-mode-dialog-agent.mjs", import.meta.url));
  let host: Host | undefined;
  try {
    const runningHost = await startHost({
      agents: { claude: { command: process.execPath, args: [`--env-file=${envFile}`, fixture] } },
      config: { attention },
    });
    host = runningHost;
    const id = randomUUID();
    const created = await runningHost.fetchApi("/sessions", "owner", {
      requestId: id, provider: "claude", projectId: "rehearsal", title: "Code Mode", prompt: "Start the session",
    });
    assert.equal(created.status, 201);
    const open = await waitFor(() => runningHost.fetchApi(`/sessions/${id}`), response =>
      response.body.attention?.state === "needs-you" && response.body.attention.prompt?.title === "Code Mode (experimental)", 15000);
    const prompt = open.body.attention.prompt;
    assert.equal(prompt.highlighted, 1);
    assert.deepEqual(prompt.options.map((option: { label: string }) => option.label), ["No, start without it", "Yes, turn on Code Mode"]);

    const owner = await claimControl(runningHost, id, "owner");
    const stale = await runningHost.fetchApi(`/sessions/${id}/answer`, "owner", {
      requestId: randomUUID(), promptId: prompt.id - 1, option: 0,
    }, owner.headers);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "prompt-changed");

    const answer = await runningHost.fetchApi(`/sessions/${id}/answer`, "owner", {
      requestId: randomUUID(), promptId: prompt.id, option: 0,
    }, owner.headers);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.result, "closed");
    const selected = await waitFor(async () => existsSync(answerFile) ? readFileSync(answerFile, "utf8") : "", value => value.length > 0, 10000);
    assert.equal(selected, "No, start without it");
  } finally {
    if (host) await host.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
