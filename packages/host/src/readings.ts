import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { choice, noul } from "@typesafe-ai/sdk";
import type { Questions, RequestOptions, SystemOneRequest, SystemOneResult, TypeSafeClient } from "@typesafe-ai/sdk";
import { firstSentence } from "@infinite/attention";
import type { Attention, Provider } from "@infinite/attention";
import type { Summarizer } from "./summary.js";
import type { Manager } from "./manager.js";
import type { Config, Session } from "./types.js";
import { unseal, writeSealed } from "./vault.js";

export type SessionReading = {
  now?: { text: string; source: "jev"; for: string; at: string };
  waitingOnYou?: boolean;
  title?: { text: string; source: "first-line" | "jev-first-line" | "writer"; model?: string };
};
export type ReadingRow = { id: string; title: string; provider: Provider; attention: Attention; reading?: SessionReading; backend?: string };
type Key = "now" | "title";
type StoredEntry = { key: string; value?: SessionReading; failedUntil?: number };
type Evaluation = { hash: string; outcome: { kind: "result"; value: SessionReading } | { kind: "failure"; failedUntil: number } };
type StoredEvaluation = { sessionId: string; type: Key; hash: string; outcome: Evaluation["outcome"] };
type PendingJob = { sessionId: string; type: Key; hash: string; work: (stillCurrent: () => boolean) => Promise<void> };
type Answers = SystemOneResult<Questions>["answers"];
export interface JevTransport {
  systemOne(request: SystemOneRequest<Questions>, options?: RequestOptions): Promise<{ answers: Answers; model: string }>;
}
const CACHE_LIMIT = 500;
const FAILURE_TTL = 10 * 60_000;
const NOW_TTL = 4_000;
const MAX_CANDIDATES = 12;
const MAX_PENDING = 50;
const FILLER_LINE = /^(?:done|all set|summary|changes made|i['’]ve made the following changes|here['’]s what\b.*)$/i;

export function messageHash(text: string) { return createHash("sha256").update(text).digest("hex"); }

/** Removes Markdown framing while preserving the agent's sentence words and order. */
export function candidateSentences(message: string): string[] {
  const cleaned = message
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, "")
    .replace(/^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/[`*_~]/g, " ");
  const sentences = (cleaned.match(/[^.!?\n]+[.!?]+(?:["')\]]+)?|[^.!?\n]+$/g) ?? [])
    .map(value => value.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map(value => value.length > 200 ? value.slice(0, 199).trimEnd() + "…" : value);
  return sentences.length > MAX_CANDIDATES
    ? [...sentences.slice(0, MAX_CANDIDATES - 1), sentences.at(-1)!]
    : sentences;
}

export function clipTitle(line: string, max = 60) {
  const firstLine = line.trim();
  if (firstLine.length <= max) return firstLine;
  const prefix = firstLine.slice(0, max + 1);
  const boundary = prefix.lastIndexOf(" ");
  return (boundary > 0 ? prefix.slice(0, boundary) : firstLine.slice(0, max)).trimEnd();
}

function defaultTitle(title: string, provider: Provider, generatedTitle?: boolean) {
  return generatedTitle === true || (generatedTitle === undefined && title === "");
}
function keyOf(id: string, type: Key, hash: string) { return `${id}:${type}:${hash}`; }
function pairOf(id: string, type: Key) { return `${id}:${type}`; }
function firstLine(prompt: string) { return prompt.split(/\r?\n/, 1)[0]?.trim() ?? ""; }

/** True only when the rule-based turn line is likely to be unhelpful on the phone. */
export function isWeakRuleLine(message: string): boolean {
  const firstRawLine = message.split(/\r?\n/).find(line => line.trim() !== "")?.trim() ?? "";
  const rawRuleLine = firstSentence(message) || "Finished a turn";
  const displayLine = rawRuleLine.length > 140 ? `${rawRuleLine.slice(0, 139)}…` : rawRuleLine;
  const filler = displayLine.replace(/[.!?…]+$/g, "").trim();
  const structured = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~|\|)/.test(firstRawLine);
  return structured || rawRuleLine.length > 140 || displayLine.length < 25 || displayLine.endsWith(":") || FILLER_LINE.test(filler);
}

/**
 * Optional, asynchronous phone readings. The cache is the only path used by list
 * requests; model work is queued in the background and never awaited by merge().
 */
export class Readings {
  private readonly file: string;
  private readonly evaluationsFile: string;
  private readonly entries = new Map<string, StoredEntry>();
  private readonly evaluations = new Map<string, Partial<Record<Key, Evaluation>>>();
  private readonly queue = new Map<string, PendingJob>();
  private readonly active = new Map<string, string>();
  private readonly latestRows = new Map<string, ReadingRow>();
  private readonly latestSessions = new Map<string, Session>();
  private observationRevision = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly apiKey?: string;
  private sdkPromise?: Promise<typeof import("@typesafe-ai/sdk")>;
  constructor(
    private readonly config: Config,
    private readonly key: Buffer,
    private readonly manager: Pick<Manager, "list" | "meta">,
    private readonly writer?: Pick<Summarizer, "titleFromPrompt">,
    private readonly transport?: JevTransport,
  ) {
    this.file = join(config.stateDir, "readings.sealed");
    this.evaluationsFile = join(config.stateDir, "reading-evaluations.sealed");
    if (config.jev) {
      this.apiKey = readFileSync(config.jev.apiKeyFile, "utf8").trim();
      if (!this.apiKey) throw new Error("Jev API key file is empty");
    }
    this.restore();
  }
  start() {
    if (!this.config.jev) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 2000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }

  /** Synchronous cache merge; stale message hashes and owner titles are omitted. */
  merge<T extends ReadingRow>(rows: T[]): T[] {
    const completeSnapshot = rows.length === 0 || rows.every(row => row.backend !== undefined);
    this.observeRows(rows, completeSnapshot ? "snapshot" : "partial");
    const merged = rows.map(row => {
      const reading: SessionReading = {};
      const message = row.attention.lastMessage ?? "";
      if (row.attention.state === "turn-finished" && message) {
        const hash = messageHash(message);
        const value = this.cached(row.id, "now", hash);
        if (value?.now?.for === hash.slice(0, 16)) {
          reading.now = value.now;
          reading.waitingOnYou = value.waitingOnYou === true;
        }
      }
      try {
        const session = this.latestSessions.get(row.id);
        const prompt = session?.initialPrompt;
        if (row.backend !== "cmux" && session && defaultTitle(session.title, session.provider, session.generatedTitle) && prompt !== undefined) {
          const line = firstLine(prompt);
          if (line) {
            const fallback = { text: line.length <= 60 ? line : clipTitle(line), source: "first-line" as const };
            const value = this.cached(row.id, "title", messageHash(prompt));
            reading.title = value?.title ?? fallback;
            if (this.config.jev && this.writer && line.length > 60) {
              this.enqueue(row.id, "title", messageHash(prompt), stillCurrent => this.readTitle(row, prompt, line, messageHash(prompt), stillCurrent));
            }
          }
        }
      } catch { /* Native cmux rows have no Infinite metadata. */ }
      if (this.config.jev) this.queueTurnReading(row);
      return Object.keys(reading).length ? { ...row, reading } : row;
    });
    if (this.config.jev) this.drain();
    return merged;
  }

  /** Captures session inputs and queues gated work. Repeated polls deduplicate pending calls. */
  async tick() {
    if (!this.config.jev) return;
    const revision = this.observationRevision;
    let rows: ReadingRow[];
    try { rows = await this.manager.list({ includeFullMessage: true }) as ReadingRow[]; } catch { return; }
    if (this.observationRevision !== revision) return;
    this.observeRows(rows, "tick");
    for (const row of rows) {
      this.queueTurnReading(row);
      const session = this.latestSessions.get(row.id);
      if (!session) continue;
      const prompt = session.initialPrompt ?? "";
      if (!defaultTitle(session.title, session.provider, session.generatedTitle) || !prompt) continue;
      const line = firstLine(prompt);
      const hash = messageHash(prompt);
      if (line.length > 60 && this.writer) this.enqueue(row.id, "title", hash, stillCurrent => this.readTitle(row, prompt, line, hash, stillCurrent));
    }
    this.drain();
  }

  private observeRows(rows: ReadingRow[], source: "partial" | "snapshot" | "tick") {
    this.observationRevision++;
    const incoming = new Set(rows.map(row => row.id));
    if (source === "snapshot" || source === "tick") {
      const retainedExternal = source === "tick"
        ? [...this.latestRows].filter(([id, row]) => row.backend === "cmux" && !incoming.has(id))
        : [];
      this.latestRows.clear();
      this.latestSessions.clear();
      for (const [id, row] of retainedExternal) this.latestRows.set(id, row);
    }
    for (const row of rows) {
      this.latestRows.set(row.id, row);
      try { this.latestSessions.set(row.id, this.manager.meta(row.id).session); }
      catch { this.latestSessions.delete(row.id); }
    }
    if (source === "partial") return;
    const live = new Set(this.latestRows.keys());
    let pruned = false;
    for (const id of this.evaluations.keys()) if (!live.has(id)) { this.evaluations.delete(id); pruned = true; }
    for (const [pair, job] of this.queue) if (!live.has(job.sessionId)) this.queue.delete(pair);
    if (pruned) this.persistEvaluations();
  }

  private queueTurnReading(row: ReadingRow) {
    const text = row.attention.lastMessage ?? "";
    if (row.attention.state !== "turn-finished" || text.length <= 200 || candidateSentences(text).length < 2 || !isWeakRuleLine(text)) return;
    const hash = messageHash(text);
    this.enqueue(row.id, "now", hash, stillCurrent => this.readNow(row, text, hash, stillCurrent));
  }

  private enqueue(sessionId: string, type: Key, hash: string, work: PendingJob["work"]) {
    if (this.cached(sessionId, type, hash)) return;
    const evaluation = this.evaluations.get(sessionId)?.[type];
    if (evaluation?.hash === hash) {
      if (evaluation.outcome.kind === "result") return;
      if (evaluation.outcome.failedUntil > Date.now()) return;
      delete this.evaluations.get(sessionId)![type];
      this.persistEvaluations();
    }
    const pair = pairOf(sessionId, type);
    if (this.active.get(pair) === hash || this.queue.get(pair)?.hash === hash) return;
    this.queue.delete(pair);
    this.queue.set(pair, { sessionId, type, hash, work });
    while (this.queue.size > MAX_PENDING) this.queue.delete(this.queue.keys().next().value!);
  }

  private drain() {
    while (this.active.size < 2 && this.queue.size) {
      const next = [...this.queue].find(([pair]) => !this.active.has(pair));
      if (!next) return;
      const [pair, job] = next;
      this.queue.delete(pair);
      this.active.set(pair, job.hash);
      const stillCurrent = () => this.isCurrent(job);
      void (async () => {
        try {
          if (stillCurrent()) await job.work(stillCurrent);
        } catch {
          this.recordEvaluation(job.sessionId, job.type, job.hash, { kind: "failure", failedUntil: Date.now() + FAILURE_TTL });
        } finally {
          if (this.active.get(pair) === job.hash) this.active.delete(pair);
          this.drain();
        }
      })();
    }
  }

  private isCurrent(job: PendingJob) {
    const row = this.latestRows.get(job.sessionId);
    if (!row) return false;
    if (job.type === "now") {
      const message = row.attention.lastMessage ?? "";
      return messageHash(message) === job.hash && row.attention.state === "turn-finished" && message.length > 200 && candidateSentences(message).length >= 2 && isWeakRuleLine(message);
    }
    const session = this.latestSessions.get(job.sessionId);
    const prompt = session?.initialPrompt ?? "";
    return Boolean(this.writer && this.config.jev && session && row.backend !== "cmux" && defaultTitle(session.title, session.provider, session.generatedTitle) && firstLine(prompt).length > 60 && messageHash(prompt) === job.hash);
  }

  private async readNow(row: ReadingRow, message: string, hash: string, stillCurrent: () => boolean) {
    const candidates = candidateSentences(message);
    if (candidates.length < 2) return;
    const options = Object.fromEntries(candidates.map((sentence, index) => [`candidate${index}`, sentence]));
    const result = await this.ask({
      state: { lastSentence: candidates.at(-1)! },
      questions: {
        best: choice("Choose the option that best tells the owner in one line what the agent did or needs from them. Each option description is the exact candidate sentence; choose only a supplied option.", options),
        waiting: noul("Does `lastSentence` ask the owner to answer a question or make a decision before the agent continues?", { true: "The agent is waiting for an answer or decision.", false: "The agent can continue without an owner response." }),
      },
    }, stillCurrent);
    if (!result) return;
    const best = result.answers.best;
    const waiting = result.answers.waiting;
    if (best.type !== "choice" || waiting.type !== "noul") throw new Error("Invalid Jev reading");
    const selected = candidates[Number(best.choice.replace("candidate", ""))];
    if (!selected) throw new Error("Jev selected an unavailable candidate");
    const reading: SessionReading = {
      now: { text: selected, source: "jev", for: hash.slice(0, 16), at: new Date().toISOString() },
      waitingOnYou: waiting.noul >= 0.6,
    };
    this.recordResult(row.id, "now", hash, reading);
  }
  private async readTitle(row: ReadingRow, prompt: string, line: string, hash: string, stillCurrent: () => boolean) {
    const clipped = clipTitle(line);
    const result = await this.ask({
      state: { clipped },
      questions: { clear: noul("Is `clipped` a clear session title?", { true: "The clipped first line clearly identifies the requested work.", false: "The clipped first line is not a clear title." }) },
    }, stillCurrent);
    if (!result) return;
    const answer = result.answers.clear;
    if (answer.type !== "noul") throw new Error("Invalid Jev title reading");
    if (answer.noul >= 0.6) {
      this.recordResult(row.id, "title", hash, { title: { text: clipped, source: "jev-first-line" } });
      return;
    }
    if (!stillCurrent()) return;
    const title = await this.writer!.titleFromPrompt(prompt);
    if (!title?.text?.trim()) throw new Error("Title writer returned no text");
    if (stillCurrent()) this.recordResult(row.id, "title", hash, { title: { text: title.text.trim().slice(0, 100), source: "writer", model: title.model } });
  }
  private async ask(request: Omit<SystemOneRequest<Questions>, "model">, stillCurrent: () => boolean) {
    const client = this.transport ?? await this.createTransport();
    if (!stillCurrent()) return undefined;
    const options: RequestOptions = { timeout: NOW_TTL, retry: { maxRetries: 0 } };
    return await client.systemOne({ ...request, model: this.config.jev!.model }, options);
  }
  private async createTransport(): Promise<JevTransport> {
    const { TypeSafeClient } = await this.sdk();
    const client = new TypeSafeClient({ apiKey: this.apiKey, baseURL: this.config.jev!.baseUrl, defaultModel: this.config.jev!.model, logLevel: "off", timeout: NOW_TTL, retry: { maxRetries: 0 } });
    return client;
  }
  private sdk() { return this.sdkPromise ??= import("@typesafe-ai/sdk"); }
  private restore() {
    if (existsSync(this.evaluationsFile)) {
      try {
        const stored = unseal<StoredEvaluation[]>(this.key, "reading-evaluations", readFileSync(this.evaluationsFile, "utf8"));
        if (Array.isArray(stored)) for (const item of stored) {
          if (!item || typeof item.sessionId !== "string" || !["now", "title"].includes(item.type) || typeof item.hash !== "string" || !item.outcome) continue;
          if (item.outcome.kind === "failure" && item.outcome.failedUntil <= Date.now()) continue;
          this.evaluations.set(item.sessionId, { ...this.evaluations.get(item.sessionId), [item.type]: { hash: item.hash, outcome: item.outcome } });
        }
      } catch { /* A damaged evaluation cache is ignored; it never blocks session lists. */ }
    }
    if (existsSync(this.file)) try {
      const stored = unseal<StoredEntry[]>(this.key, "readings", readFileSync(this.file, "utf8"));
      if (!Array.isArray(stored)) return;
      for (const entry of stored) {
        if (!entry || typeof entry.key !== "string") continue;
        const match = /^([^:]+):(now|title):([a-f0-9]{64})$/.exec(entry.key);
        if (!match) continue;
        const sessionId = match[1]!;
        const type = match[2] as Key;
        const hash = match[3]!;
        if (entry.value) {
          this.entries.set(entry.key, entry);
          if (!this.evaluations.get(sessionId)?.[type]) this.evaluations.set(sessionId, { ...this.evaluations.get(sessionId), [type]: { hash, outcome: { kind: "result", value: entry.value } } });
        } else if (entry.failedUntil && entry.failedUntil > Date.now() && !this.evaluations.get(sessionId)?.[type]) {
          this.evaluations.set(sessionId, { ...this.evaluations.get(sessionId), [type]: { hash, outcome: { kind: "failure", failedUntil: entry.failedUntil } } });
        }
      }
      while (this.entries.size > CACHE_LIMIT) this.entries.delete(this.entries.keys().next().value!);
    } catch { /* A damaged reading cache is ignored; it never blocks session lists. */ }
  }

  private cached(sessionId: string, type: Key, hash: string) {
    const evaluation = this.evaluations.get(sessionId)?.[type];
    if (evaluation?.hash === hash && evaluation.outcome.kind === "result") return evaluation.outcome.value;
    const entry = this.get(keyOf(sessionId, type, hash));
    if (entry?.value) return entry.value;
    return undefined;
  }

  private get(key: string) {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key); this.entries.set(key, value);
    return value;
  }

  private recordResult(sessionId: string, type: Key, hash: string, value: SessionReading) {
    if (!this.latestRows.has(sessionId)) return;
    this.recordEvaluation(sessionId, type, hash, { kind: "result", value });
    this.put({ key: keyOf(sessionId, type, hash), value });
  }

  private recordEvaluation(sessionId: string, type: Key, hash: string, outcome: Evaluation["outcome"]) {
    if (!this.latestRows.has(sessionId)) return;
    this.evaluations.set(sessionId, { ...this.evaluations.get(sessionId), [type]: { hash, outcome } });
    this.persistEvaluations();
  }

  private persistEvaluations() {
    const stored: StoredEvaluation[] = [];
    for (const [sessionId, byType] of this.evaluations) for (const type of ["now", "title"] as const) {
      const evaluation = byType[type];
      if (evaluation) stored.push({ sessionId, type, hash: evaluation.hash, outcome: evaluation.outcome });
    }
    try { writeSealed(this.evaluationsFile, this.key, "reading-evaluations", stored); } catch { /* Backoff persistence is best effort. */ }
  }

  private put(entry: StoredEntry) {
    if (!entry.value) return;
    this.entries.delete(entry.key); this.entries.set(entry.key, entry);
    while (this.entries.size > CACHE_LIMIT) this.entries.delete(this.entries.keys().next().value!);
    try { writeSealed(this.file, this.key, "readings", [...this.entries.values()]); } catch { /* Cache persistence is best effort. */ }
  }
}
