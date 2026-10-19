import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
type Answers = SystemOneResult<Questions>["answers"];
export interface JevTransport {
  systemOne(request: SystemOneRequest<Questions>, options?: RequestOptions): Promise<{ answers: Answers; model: string }>;
}
const CACHE_LIMIT = 500;
const FAILURE_TTL = 10 * 60_000;
const NOW_TTL = 4_000;
const MAX_CANDIDATES = 12;
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
function firstLine(prompt: string) { return prompt.split(/\r?\n/, 1)[0]?.trim() ?? ""; }

/** True only when the rule-based turn line is likely to be unhelpful on the phone. */
export function isWeakRuleLine(message: string): boolean {
  const firstRawLine = message.split(/\r?\n/).find(line => line.trim() !== "")?.trim() ?? "";
  const rawRuleLine = firstSentence(message) || "Finished a turn";
  const displayLine = rawRuleLine.length > 140 ? `${rawRuleLine.slice(0, 139)}…` : rawRuleLine;
  const filler = displayLine.replace(/[.!?…]+$/g, "").trim();
  const structured = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~)/.test(firstRawLine) || firstRawLine.includes("|");
  return structured || rawRuleLine.length > 140 || displayLine.length < 25 || displayLine.endsWith(":") || FILLER_LINE.test(filler);
}

/**
 * Optional, asynchronous phone readings. The cache is the only path used by list
 * requests; model work is queued in the background and never awaited by merge().
 */
export class Readings {
  private readonly file: string;
  private readonly entries = new Map<string, StoredEntry>();
  private readonly queue: (() => Promise<void>)[] = [];
  private readonly inflight = new Set<string>();
  private active = 0;
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
    const merged = rows.map(row => {
      const reading: SessionReading = {};
      const message = row.attention.lastMessage ?? "";
      if (row.attention.state === "turn-finished" && message) {
        const hash = messageHash(message);
        const entry = this.get(keyOf(row.id, "now", hash));
        if (entry?.value?.now?.for === hash.slice(0, 16)) {
          reading.now = entry.value.now;
          reading.waitingOnYou = entry.value.waitingOnYou === true;
        }
      }
      try {
        const session = this.manager.meta(row.id).session;
        const prompt = session.initialPrompt;
        if (row.backend !== "cmux" && defaultTitle(session.title, session.provider, session.generatedTitle) && prompt !== undefined) {
          const line = firstLine(prompt);
          if (line) {
            const titleKey = keyOf(row.id, "title", messageHash(prompt));
            const fallback = { text: line.length <= 60 ? line : clipTitle(line), source: "first-line" as const };
            const entry = this.get(titleKey);
            reading.title = entry?.value?.title ?? fallback;
            if (this.config.jev && this.writer && line.length > 60) {
              this.enqueue(titleKey, () => this.readTitle(row, prompt, line));
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
    let rows: ReadingRow[];
    try { rows = await this.manager.list({ includeFullMessage: true }) as ReadingRow[]; } catch { return; }
    for (const row of rows) {
      this.queueTurnReading(row);
      let session: Session;
      try { session = this.manager.meta(row.id).session; } catch { continue; }
      const prompt = session.initialPrompt ?? "";
      if (!defaultTitle(session.title, session.provider, session.generatedTitle) || !prompt) continue;
      const line = firstLine(prompt);
      if (line.length > 60 && this.writer) this.enqueue(keyOf(row.id, "title", messageHash(prompt)), () => this.readTitle(row, prompt, line));
    }
    this.drain();
  }

  private queueTurnReading(row: ReadingRow) {
    const text = row.attention.lastMessage ?? "";
    if (row.attention.state !== "turn-finished" || text.length <= 200 || candidateSentences(text).length < 2 || !isWeakRuleLine(text)) return;
    this.enqueue(keyOf(row.id, "now", messageHash(text)), () => this.readNow(row, text));
  }

  private enqueue(key: string, work: () => Promise<void>) {
    const cached = this.get(key);
    if (cached && (!cached.failedUntil || cached.failedUntil > Date.now())) return;
    if (cached?.failedUntil && cached.failedUntil <= Date.now()) this.entries.delete(key);
    if (this.inflight.has(key)) return;
    this.inflight.add(key);
    this.queue.push(async () => {
      try { await work(); }
      catch { this.put({ key, failedUntil: Date.now() + FAILURE_TTL }); }
      finally { this.inflight.delete(key); }
    });
  }
  private drain() {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void job().finally(() => { this.active--; this.drain(); });
    }
  }
  private async readNow(row: ReadingRow, message: string) {
    const candidates = candidateSentences(message);
    if (candidates.length < 2) return;
    const { choice, noul } = await this.sdk();
    const options = Object.fromEntries(candidates.map((sentence, index) => [`candidate${index}`, sentence]));
    const result = await this.ask({
      state: { lastSentence: candidates.at(-1)! },
      questions: {
        best: choice("Choose the option that best tells the owner in one line what the agent did or needs from them. Each option description is the exact candidate sentence; choose only a supplied option.", options),
        waiting: noul("Does `lastSentence` ask the owner to answer a question or make a decision before the agent continues?", { true: "The agent is waiting for an answer or decision.", false: "The agent can continue without an owner response." }),
      },
    });
    const best = result.answers.best;
    const waiting = result.answers.waiting;
    if (best.type !== "choice" || waiting.type !== "noul") throw new Error("Invalid Jev reading");
    const selected = candidates[Number(best.choice.replace("candidate", ""))];
    if (!selected) throw new Error("Jev selected an unavailable candidate");
    const hash = messageHash(message);
    const reading: SessionReading = {
      now: { text: selected, source: "jev", for: hash.slice(0, 16), at: new Date().toISOString() },
      waitingOnYou: waiting.noul >= 0.6,
    };
    this.put({ key: keyOf(row.id, "now", hash), value: reading });
  }
  private async readTitle(row: ReadingRow, prompt: string, line: string) {
    const clipped = clipTitle(line);
    const { noul } = await this.sdk();
    const result = await this.ask({
      state: { clipped },
      questions: { clear: noul("Is `clipped` a clear session title?", { true: "The clipped first line clearly identifies the requested work.", false: "The clipped first line is not a clear title." }) },
    });
    const answer = result.answers.clear;
    if (answer.type !== "noul") throw new Error("Invalid Jev title reading");
    const key = keyOf(row.id, "title", messageHash(prompt));
    if (answer.noul >= 0.6) {
      this.put({ key, value: { title: { text: clipped, source: "jev-first-line" } } });
      return;
    }
    const title = await this.writer!.titleFromPrompt(prompt);
    if (!title?.text?.trim()) throw new Error("Title writer returned no text");
    this.put({ key, value: { title: { text: title.text.trim().slice(0, 100), source: "writer", model: title.model } } });
  }
  private async ask(request: Omit<SystemOneRequest<Questions>, "model">) {
    const client = this.transport ?? await this.createTransport();
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
    if (!existsSync(this.file)) return;
    try {
      const stored = unseal<StoredEntry[]>(this.key, "readings", readFileSync(this.file, "utf8"));
      if (!Array.isArray(stored)) return;
      for (const entry of stored) if (entry && typeof entry.key === "string" && (entry.value || (entry.failedUntil && entry.failedUntil > Date.now()))) this.entries.set(entry.key, entry);
      while (this.entries.size > CACHE_LIMIT) this.entries.delete(this.entries.keys().next().value!);
    } catch { /* A damaged reading cache is ignored; it never blocks session lists. */ }
  }
  private get(key: string) {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key); this.entries.set(key, value);
    return value;
  }
  private put(entry: StoredEntry) {
    this.entries.delete(entry.key); this.entries.set(entry.key, entry);
    while (this.entries.size > CACHE_LIMIT) this.entries.delete(this.entries.keys().next().value!);
    try { writeSealed(this.file, this.key, "readings", [...this.entries.values()]); } catch { /* Cache persistence is best effort. */ }
  }
}
