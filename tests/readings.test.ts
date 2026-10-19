import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Attention } from "@infinite/attention";
import type { Config, Provider, Session } from "../packages/host/src/types.js";
import { Readings, candidateSentences, clipTitle, messageHash, type JevTransport, type ReadingRow } from "../packages/host/src/readings.js";
import { Summarizer } from "../packages/host/src/summary.js";

const longLine = "Investigate the database read path and compare its consistency guarantees across the worker, API, and phone clients before changing any behavior.";
const longMessage = `Updated the session list to keep cached rows responsive while background readings are generated. ${"The rule-based attention state remains unchanged and the cached fallback still appears immediately. ".repeat(2)}I need you to choose whether to ship this behavior next.`;
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
    await f.readings.tick();
    await eventually(() => Boolean(f.readings.merge([f.row])[0].reading?.now));
    const reading = f.readings.merge([f.row])[0].reading!;
    assert.equal(reading.now?.text, candidateSentences(longMessage)[1]);
    assert.equal(reading.now?.source, "jev");
    assert.equal(reading.now?.for, messageHash(longMessage).slice(0, 16));
    assert.equal(reading.waitingOnYou, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].questions.waiting.type, "noul");
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
    await eventually(() => Boolean(f.readings.merge([f.row])[0].reading?.title));
    assert.equal(fake.calls.length, 1);
    assert.equal(writerCalls, 0);
    const title = f.readings.merge([f.row])[0].reading?.title;
    assert.equal(title?.text, clipTitle(prompt.split("\n")[0]));
    assert.equal(title?.source, "jev-first-line");
  } finally { f.dispose(); }
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

test("without Jev configuration the host makes no Jev calls", async () => {
  const fake = responding({});
  const f = setup({ transport: fake.transport });
  try {
    const disabled = new Readings({ ...f.config, jev: undefined }, f.key, f.manager, undefined, fake.transport);
    await disabled.tick();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fake.calls.length, 0);
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

test("candidate and title clipping helpers remove Markdown framing and preserve word boundaries", () => {
  assert.deepEqual(candidateSentences("# Summary\n- Changed the [session list](https://example.invalid).\n\nThe cache is sealed."), ["Changed the session list.", "The cache is sealed."]);
  assert.deepEqual(candidateSentences("Summary.\n```js\nconst hidden = true;\n```\nUpdated the cache."), ["Summary.", "Updated the cache."]);
  const many = Array.from({ length: 15 }, (_, i) => `Sentence ${i + 1}.`).join(" ");
  assert.equal(candidateSentences(many).length, 12);
  assert.equal(candidateSentences(many).at(-1), "Sentence 15.");
  assert.ok(clipTitle(`${"1234567890 ".repeat(6)}end`).length <= 60);
});
