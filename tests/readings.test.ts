import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Attention } from "@infinite/attention";
import type { Config, Provider, Session } from "../packages/host/src/types.js";
import { Readings, candidateSentences, clipTitle, isWeakRuleLine, messageHash, titleInput, type JevTransport, type ReadingRow } from "../packages/host/src/readings.js";
import { Summarizer } from "../packages/host/src/summary.js";

const longLine = "Investigate the database read path and compare its consistency guarantees across the worker, API, and phone clients before changing any behavior.";
const longMessage = `## Summary\nUpdated the session list to keep cached rows responsive while background readings are generated. ${"The rule-based attention state remains unchanged and the cached fallback still appears immediately. ".repeat(2)}I need you to choose whether to ship this behavior next.`;
const now = (lastMessage: string): Attention => ({ state: "turn-finished", since: new Date().toISOString(), source: "hook", now: "Done.", lastMessage, lastActivityAt: new Date().toISOString(), hooks: "active", hookErrors: 0, sawTurnEnd: true });

function setup(options: { title?: string; prompt?: string; provider?: Provider; generatedTitle?: true; transport?: JevTransport; writer?: Pick<Summarizer, "titleFromPrompt">; lastMessage?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "inf-readings-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir);
  const apiKeyFile = join(root, "jev.key");
  writeFileSync(apiKeyFile, "test-key", { mode: 0o600 });
  const key = randomBytes(32);
  const id = randomUUID();
  const session: Session = {
    id, provider: options.provider ?? "claude", title: options.title ?? "claude session",
    projectId: "rehearsal", cwd: root, createdAt: new Date().toISOString(), status: "exited", contextVersion: 0,
    context: "", initialPrompt: options.prompt ?? "", ...(options.generatedTitle ? { generatedTitle: true as const } : {}),
  };
  const row: ReadingRow = { id, title: session.title, provider: session.provider, attention: now(options.lastMessage ?? longMessage) };
  const manager = { list: async () => [row], meta: () => ({ session }) } as any;
  const config = { stateDir, jev: { apiKeyFile, model: "jev-latest", baseUrl: "https://api.typesafe.ai" } } as Config;
  const readings = new Readings(config, key, manager, options.writer, options.transport);
  return { root, row, session, manager, readings, config, key, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function responding(answers: { best?: string; waiting?: number; clear?: number }, onCall?: (request: any) => void) {
  const calls: any[] = [];
  const transport = {
    systemOne: async (request: any) => {
      calls.push(request); onCall?.(request);
      const criteria = request.questions.best?.criteria ?? {};
      const selected = answers.best ?? Object.keys(criteria)[0] ?? "candidate0";
      return { model: "jev-latest", answers: {
        ...(request.questions.best ? { best: { type: "choice", choice: selected, confidence: 0.9, probabilities: {} } } : {}),
        ...(request.questions.waiting ? { waiting: { type: "noul", noul: answers.waiting ?? 0.2 } } : {}),
        ...(request.questions.clear ? { clear: { type: "noul", noul: answers.clear ?? 0.2 } } : {}),
      } };
    },
  } as unknown as JevTransport;
  return { transport, calls };
}

async function eventually(predicate: () => boolean, timeout = 2000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("condition was not reached");
}

test("turn reading picks an agent sentence verbatim and applies the noul threshold", async () => {
  const fake = responding({ best: "candidate1", waiting: 0.6 });
  const f = setup({ transport: fake.transport });
  try {
    const immediate = f.readings.merge([f.row]);
    assert.equal(immediate[0].attention.now, "Done.");
    await eventually(() => Boolean(f.readings.merge([f.row])[0].reading?.now));
    const reading = f.readings.merge([f.row])[0].reading!;
    assert.equal(reading.now?.text, candidateSentences(longMessage)[1]);
    assert.equal(reading.now?.source, "jev");
    assert.equal(reading.now?.for, messageHash(longMessage).slice(0, 16));
    assert.equal(reading.waitingOnYou, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].questions.waiting.type, "noul");
    assert.deepEqual(fake.calls[0].questions.best.criteria, Object.fromEntries(candidateSentences(longMessage).map((sentence, index) => [`candidate${index}`, sentence])));
    assert.deepEqual(fake.calls[0].state, { lastSentence: candidateSentences(longMessage).at(-1) });
    await f.readings.tick();
    assert.equal(fake.calls.length, 1, "the populated hash is a cache hit on the next poll");
  } finally { f.dispose(); }
});

test("waitingOnYou is false below the 0.6 noul threshold", async () => {
  const fake = responding({ best: "candidate0", waiting: 0.59 });
  const f = setup({ transport: fake.transport });
  try {
    await f.readings.tick();
    await eventually(() => Boolean(f.readings.merge([f.row])[0].reading?.now));
    assert.equal(f.readings.merge([f.row])[0].reading?.waitingOnYou, false);
  } finally { f.dispose(); }
});

test("short and single-candidate turns, owner titles, and short generated first lines make no Jev call", async () => {
  const short = responding({}), onlyCandidate = responding({}), owner = responding({}), titleCall = responding({});
  const f = setup({ lastMessage: "Short.", transport: short.transport, title: "Personal title", prompt: longLine });
  const single = setup({ lastMessage: `${"One candidate without any sentence boundary ".repeat(8)}ends here.`, transport: onlyCandidate.transport });
  const ownerTitle = setup({ lastMessage: "Short.", title: "Personal title", prompt: longLine, transport: owner.transport });
  const title = setup({ lastMessage: "Short.", title: "", generatedTitle: true, prompt: "Fix the retry race\nSecond line is not used", transport: titleCall.transport });
  try {
    await f.readings.tick(); await single.readings.tick(); await title.readings.tick();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(short.calls.length + onlyCandidate.calls.length + owner.calls.length + titleCall.calls.length, 0);
    assert.equal(ownerTitle.readings.merge([ownerTitle.row])[0].reading, undefined, "an owner title is not replaced by a prompt-derived title");
    assert.equal(title.readings.merge([title.row])[0].reading?.title?.text, "Fix the retry race");
  } finally { f.dispose(); single.dispose(); ownerTitle.dispose(); title.dispose(); }
});

test("long generated titles ask Jev only with a writer and pass only the clipped first line", async () => {
  const prompt = `${longLine} ${"with enough extra context to require a clipped title".repeat(3)}\nDo not send this later line to Jev.`;
  const fake = responding({ clear: 0.9 }, request => assert.deepEqual(request.state, { clipped: clipTitle(prompt.split("\n")[0]) }));
  let writerCalls = 0;
  const writer = { titleFromPrompt: async () => { writerCalls++; return { text: "Database read consistency", model: "writer-model" }; } };
  const f = setup({ lastMessage: "Short.", title: "", generatedTitle: true, prompt, transport: fake.transport, writer });
  try {
    await f.readings.tick();
    await eventually(() => f.readings.merge([f.row])[0].reading?.title?.source === "jev-first-line");
    assert.equal(fake.calls.length, 1);
    assert.equal(writerCalls, 0);
    const title = f.readings.merge([f.row])[0].reading?.title;
    assert.equal(title?.text, clipTitle(prompt.split("\n")[0]));
    assert.equal(title?.source, "jev-first-line");
  } finally { f.dispose(); }
});

test("team request titles keep short lines, keep clear clipped lines, and otherwise ask the writer with paths removed", async () => {
  const inputs: string[] = [];
  const writer = { titleFromPrompt: async (prompt: string) => { inputs.push(prompt); return { text: "Database read consistency", model: "writer-model" }; } };
  const clear = responding({ clear: 0.9 }), unclear = responding({ clear: 0.1 });
  const a = setup({ transport: clear.transport, writer }), b = setup({ transport: unclear.transport, writer });
  const withoutJev = new Readings({ ...a.config, jev: undefined }, a.key, a.manager, writer);
  const withoutWriter = new Readings(a.config, a.key, a.manager, undefined, clear.transport);
  const prompt = `Start from /srv/private/notes.md and ${longLine.toLowerCase()}\nKeep the later line.`;
  try {
    assert.equal(await a.readings.requestTitle("Fix the retry race\nWith a long second line that is never used for the title"), undefined);
    assert.equal(await withoutWriter.requestTitle(prompt), undefined);
    assert.deepEqual(await a.readings.requestTitle(prompt), { text: clipTitle(titleInput(prompt).split("\n")[0]) });
    assert.deepEqual(clear.calls.map(call => call.state), [{ clipped: clipTitle(titleInput(prompt).split("\n")[0]) }]);
    assert.equal(inputs.length, 0);
    assert.deepEqual(await b.readings.requestTitle(prompt), { text: "Database read consistency", model: "writer-model" });
    assert.deepEqual(await withoutJev.requestTitle(prompt), { text: "Database read consistency", model: "writer-model" });
    assert.deepEqual(inputs, [titleInput(prompt), titleInput(prompt)]);
    assert.match(inputs[0]!, /Start from \[local path omitted\]/);
    assert.doesNotMatch(JSON.stringify(clear.calls), /\/srv\/private/, "Jev sees the redacted line too");
    assert.equal(unclear.calls.length, 1);
  } finally { a.dispose(); b.dispose(); }
});

test("team title input removes absolute and quoted paths without dropping the request", () => {
  for (const path of ["/srv/private/customer-contract.md", '"/home/dev/Client Alpha/contract.md"',
    "'/opt/Client Beta/contract.md'", "`/mnt/Client Gamma/contract.md`", "/data/contracts/draft.md", "~/contracts/draft.md",
    '"~/Client Alpha/contract.md"', "C:\\contracts\\draft.md", '"C:\\Client Alpha\\contract.md"', "D:/contracts/draft.md",
    "file:///srv/private/client-contract.md", "/.env", "/secrets", "/home/dev/Client Alpha/contract.md"])
    assert.equal(titleInput(`Review ${path} using docs/review.md and https://example.invalid/help/review`),
      "Review [local path omitted] using docs/review.md and https://example.invalid/help/review", path);
});

test("no writer means a long default title uses a word-boundary clip without a Jev call", async () => {
  const fake = responding({});
  const line = `${longLine} with a longer phrase after the sixty character boundary`;
  const f = setup({ lastMessage: "Short.", title: "", generatedTitle: true, prompt: line, transport: fake.transport });
  try {
    await f.readings.tick();
    const reading = f.readings.merge([f.row])[0].reading?.title;
    assert.equal(reading?.text, clipTitle(line));
    assert.equal(reading?.source, "first-line");
    assert.equal(fake.calls.length, 0);
  } finally { f.dispose(); }
});

test("without Jev configuration start and tick do no polling, while merge derives titles locally", async () => {
  const fake = responding({});
  const f = setup({ title: "", generatedTitle: true, prompt: longLine, lastMessage: "Short.", transport: fake.transport });
  try {
    const disabled = new Readings({ ...f.config, jev: undefined }, f.key, f.manager, undefined, fake.transport);
    let listCalls = 0;
    f.manager.list = async () => { listCalls++; return [f.row]; };
    const originalSetInterval = globalThis.setInterval;
    let intervalCalls = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => { intervalCalls++; return originalSetInterval(...args); }) as typeof setInterval;
    try { disabled.start(); await disabled.tick(); }
    finally { globalThis.setInterval = originalSetInterval; disabled.stop(); }
    const reading = disabled.merge([f.row])[0].reading;
    assert.equal(reading?.title?.text, clipTitle(longLine));
    assert.equal(reading?.title?.source, "first-line");
    assert.equal(intervalCalls, 0, "the no-Jev service starts no polling timer");
    assert.equal(listCalls, 0, "the no-Jev service never lists sessions in the background");
    assert.equal(fake.calls.length, 0);
  } finally { f.dispose(); }
});

test("background polling retains compact session snapshots instead of full prompts and messages", async () => {
  const f = setup({ title: "", generatedTitle: true, prompt: "p".repeat(100_000), lastMessage: "m".repeat(100_000) });
  f.row.attention = { ...f.row.attention, state: "working" };
  try {
    await f.readings.tick();
    const state = f.readings as unknown as { latestRows: Map<string, unknown>; latestSessions: Map<string, unknown> };
    const retained = JSON.stringify({ rows: [...state.latestRows.values()], sessions: [...state.latestSessions.values()] });
    assert.ok(retained.length < 2_048, `retained row and session snapshots were ${retained.length} bytes`);
  } finally { f.dispose(); }
});

test("failures are held briefly, list merging stays synchronous, stale hashes drop, and cache survives restart", async () => {
  let calls = 0;
  const failing = { systemOne: async () => { calls++; throw new Error("timeout"); } } as unknown as JevTransport;
  const f = setup({ transport: failing });
  try {
    await f.readings.tick();
    assert.ok(Array.isArray(f.readings.merge([f.row])));
    await eventually(() => calls === 1);
    await f.readings.tick();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 1, "the failure cache prevents a retry on the next poll");
    assert.equal(f.readings.merge([f.row])[0].reading, undefined);
    assert.equal(f.row.attention.now, "Done.", "failure leaves the rule line as the fallback");

    const saved = setup();
    const success = responding({ best: "candidate0", waiting: 0.1 });
    const populated = new Readings(saved.config, saved.key, saved.manager, undefined, success.transport);
    await populated.tick();
    await eventually(() => Boolean(populated.merge([saved.row])[0].reading?.now));
    const restarted = new Readings(saved.config, saved.key, saved.manager, undefined, success.transport);
    assert.equal(restarted.merge([saved.row])[0].reading?.now?.text, candidateSentences(longMessage)[0]);
    assert.equal(success.calls.length, 1);
    await restarted.tick();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(success.calls.length, 1, "a persisted reading survives API restart without another Jev call");
    saved.row.attention = now(`${longMessage} Changed.`);
    assert.equal(restarted.merge([saved.row])[0].reading, undefined, "a different lastMessage hash drops the reading");
    saved.dispose();
  } finally { f.dispose(); }
});

test("a list row merge returns while Jev is still pending", async () => {
  let calls = 0;
  const pending = { systemOne: async () => { calls++; return new Promise<never>(() => {}); } } as unknown as JevTransport;
  const f = setup({ transport: pending });
  try {
    await f.readings.tick();
    await eventually(() => calls === 1);
    const result = f.readings.merge([f.row]);
    assert.equal(result[0].attention.now, "Done.");
    assert.equal(result[0].reading, undefined);
  } finally { f.readings.stop(); f.dispose(); }
});

test("an older poll result cannot replace a newer ineligible row", async () => {
  const fake = responding({});
  const f = setup({ transport: fake.transport });
  let resolveList!: (rows: ReadingRow[]) => void;
  f.manager.list = () => new Promise(resolve => { resolveList = resolve; });
  try {
    const poll = f.readings.tick();
    const current = { ...f.row, attention: now("A short current status.") };
    f.readings.merge([current]);
    resolveList([f.row]);
    await poll;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(fake.calls.length, 0, "a stale poll cannot reopen the Jev gate after merge observed newer content");
  } finally { f.dispose(); }
});

test("501 failed turn readings stay suppressed after the display LRU would have evicted entries", async () => {
  let calls = 0;
  const failing = { systemOne: async () => { calls++; throw new Error("provider unavailable"); } } as unknown as JevTransport;
  const f = setup({ transport: failing });
  const rows: ReadingRow[] = Array.from({ length: 501 }, (_, index) => {
    const id = `session-${index}`;
    const session = { ...f.session, id };
    const message = `${longMessage} Session ${index}.`;
    return { id, title: session.title, provider: session.provider, attention: now(message) };
  });
  const sessions = new Map(rows.map(row => [row.id, { ...f.session, id: row.id }]));
  f.manager.meta = (id: string) => ({ session: sessions.get(id) });
  try {
    for (let offset = 0; offset < rows.length; offset += 25) {
      const batch = rows.slice(offset, offset + 25);
      f.readings.merge(batch);
      const expected = offset + batch.length;
      await eventually(() => calls === expected);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    f.manager.list = async () => rows;
    await f.readings.tick();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 501, "a full scan does not retry failures merely because the display cache is bounded");

    f.manager.list = async () => rows.slice(0, 1);
    await f.readings.tick();
    const evaluations = (f.readings as unknown as { evaluations: Map<string, unknown> }).evaluations;
    assert.equal(evaluations.size, 1, "evaluation/backoff entries are pruned with sessions that leave the live snapshot");
  } finally { f.dispose(); }
});

test("many eligible rows keep pending Jev work within the 50-job cap", () => {
  const pending = { systemOne: async () => new Promise<never>(() => {}) } as unknown as JevTransport;
  const f = setup({ transport: pending });
  const rows: ReadingRow[] = Array.from({ length: 5000 }, (_, index) => {
    const id = `session-${index}`;
    return { id, title: "Worker session", provider: "claude", attention: now(`${longMessage} Session ${index}.`) };
  });
  f.manager.meta = (id: string) => ({ session: { ...f.session, id } });
  try {
    f.readings.merge(rows);
    const state = f.readings as unknown as { queue: Map<string, unknown>; active: Map<string, string> };
    assert.equal(state.active.size, 2, "only two provider requests can run at once");
    assert.ok(state.queue.size <= 50, `pending work was ${state.queue.size}, above the cap`);
  } finally { f.dispose(); }
});

test("pending work coalesces to the newest hash and rechecks the gate before send", async () => {
  const calls: any[] = [];
  const releases: Array<(value: any) => void> = [];
  const transport = { systemOne: (request: any) => {
    calls.push(request);
    return new Promise(resolve => releases.push(resolve));
  } } as unknown as JevTransport;
  const f = setup({ transport });
  const blockerRows = ["blocker-a", "blocker-b"].map(id => ({
    id, title: "Worker session", provider: "claude" as const, attention: now(`${longMessage} ${id}.`),
  }));
  const target = (id: string, attention: Attention): ReadingRow => ({ id, title: "Worker session", provider: "claude", attention });
  const oldMessage = `${longMessage} Old queued sentence.`;
  const newerMessage = `${longMessage} New queued sentence.`;
  const gateMessage = `${longMessage} Gate held sentence.`;
  const gatedRow = target("gated", now(gateMessage));
  f.manager.meta = (id: string) => ({ session: { ...f.session, id } });
  try {
    f.readings.merge([...blockerRows, target("coalesced", now(oldMessage)), gatedRow]);
    await eventually(() => calls.length === 2);
    f.readings.merge([target("coalesced", now(newerMessage))]);
    f.readings.merge([target("gated", { ...gatedRow.attention, state: "working" })]);

    const answer = { model: "jev-latest", answers: {
      best: { type: "choice", choice: "candidate0", confidence: 0.9, probabilities: {} },
      waiting: { type: "noul", noul: 0.1 },
    } };
    releases.forEach(release => release(answer));
    await eventually(() => calls.length === 3);
    assert.equal(calls[2].state.lastSentence, "New queued sentence.", "the pending slot sends only its newest hash");
    assert.equal(calls.some(request => request.state.lastSentence === "Gate held sentence."), false, "a message that no longer passes the turn-finished gate is skipped before send");
    releases.slice(2).forEach(release => release(answer));
  } finally { f.dispose(); }
});

test("candidate and title clipping helpers remove Markdown framing and preserve word boundaries", () => {
  assert.deepEqual(candidateSentences("# Summary\n- Changed the [session list](https://example.invalid).\n\nThe cache is sealed."), ["Changed the session list.", "The cache is sealed."]);
  assert.deepEqual(candidateSentences("Summary.\n```js\nconst hidden = true;\n```\nUpdated the cache."), ["Summary.", "Updated the cache."]);
  const many = Array.from({ length: 15 }, (_, i) => `Sentence ${i + 1}.`).join(" ");
  assert.equal(candidateSentences(many).length, 12);
  assert.equal(candidateSentences(many).at(-1), "Sentence 15.");
  assert.ok(clipTitle(`${"1234567890 ".repeat(6)}end`).length <= 60);
});

test("weak rule-line gate admits weak presentation and rejects clear rule-based prose", () => {
  const clear = `Updated the retry handler to preserve the worker state after a transient connection loss. ${"The session now reconnects without replaying accepted input. ".repeat(3)}The list keeps serving the same recorded attention state.`;
  const heading = `## Summary\n${clear}`;
  const list = `- Updated the retry handler to preserve the worker state after a transient connection loss. ${"The session now reconnects without replaying accepted input. ".repeat(3)}`;
  const table = `Component | Result\n${clear}`;
  const code = `\`\`\`text\n${clear}`;
  const clipped = `${"Updated the retry handler to preserve the worker state after a transient connection loss and keep accepted input stable ".repeat(2)}Additional detail follows.`;
  assert.ok(clear.length > 200);
  assert.equal(isWeakRuleLine(clear), false, "a clear substantive sentence should keep the zero-call path");
  assert.equal(isWeakRuleLine(heading), true, "a heading-first response has a weak rule line");
  assert.equal(isWeakRuleLine(list), true, "a list-first response has a weak rule line");
  assert.equal(isWeakRuleLine(table), true, "a table-first response has a weak rule line");
  assert.equal(isWeakRuleLine(`I piped the log through \`grep | sort\` and fixed the duplicate rows.\n${clear}`), false, "a pipe inside a clear sentence is not a table");
  assert.equal(isWeakRuleLine(code), true, "a code-fence-first response has a weak rule line");
  assert.equal(isWeakRuleLine(`Done.\n${clear}`), true, "a filler opening has a weak rule line");
  assert.equal(isWeakRuleLine(`Progress:\n${clear}`), true, "a colon-ended lead-in has a weak rule line");
  assert.equal(isWeakRuleLine(`Changes made.\n${clear}`), true, "a filler summary lead-in has a weak rule line");
  assert.equal(isWeakRuleLine(clipped), true, "a first sentence longer than the display cap has a weak rule line");
});
