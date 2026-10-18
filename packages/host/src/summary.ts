// Model-written digests of a session's chat for a person who stepped away. A summary is a
// reading of the recorded messages, labeled with the model that wrote it; it never claims a
// result the messages do not contain, and the host never acts on it.
import { readFileSync } from "node:fs";
import type { ChatMessage } from "./session-content.js";

export interface SummaryConfig { model: string; apiKeyFile: string; baseUrl: string }
export interface Summary {
  model: string;
  text: string;
  /** Message cursors the summary covers, so a client can ask for what came after. */
  from: string;
  to: string;
  messages: number;
  at: string;
}
export class SummaryError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

const INSTRUCTIONS = [
  "You summarize a transcript between a person and a coding agent for that person, who stepped away.",
  "Use only what the messages say. Describe what the agent did and reported, in the past tense, in at most six short sentences of plain text with no headings or lists.",
  "When the agent claims a result, such as tests passing or work being finished, attribute it to the agent, for example \"the agent says\"; never state such a claim as fact.",
  "End by naming any question, approval, or decision the agent is waiting on, or say that the agent was not waiting on anything in these messages.",
].join(" ");
const MAX_INPUT_CHARS = 120_000;
const MAX_CACHE = 64;

/** The chat as plain text, keeping the most recent part when it is too long. */
export function transcriptText(messages: ChatMessage[]): string {
  const lines = messages.map(message => message.role === "user" ? `Person: ${message.text}`
    : message.role === "assistant" ? `Agent: ${message.text}` : `Agent ran ${message.toolName ?? "a tool"}: ${message.text.split("\n")[0].slice(0, 200)}`);
  let text = lines.join("\n\n");
  if (text.length > MAX_INPUT_CHARS) text = "[earlier messages omitted]\n\n" + text.slice(text.length - MAX_INPUT_CHARS);
  return text;
}

/** Extracts the assistant text from an OpenAI Responses API result. */
export function responseText(body: unknown): string {
  const output = (body as { output?: unknown })?.output;
  if (!Array.isArray(output)) return "";
  return output.flatMap(item => item && typeof item === "object" && (item as { type?: unknown }).type === "message" && Array.isArray((item as { content?: unknown }).content)
    ? ((item as { content: unknown[] }).content).map(part => part && typeof part === "object" && (part as { type?: unknown }).type === "output_text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")
    : []).join("").trim();
}

export class Summarizer {
  private readonly key: string;
  private readonly cache = new Map<string, Summary>();
  private readonly inflight = new Map<string, Promise<Summary>>();
  constructor(readonly config: SummaryConfig, private readonly fetcher: typeof fetch = fetch) {
    this.key = readFileSync(config.apiKeyFile, "utf8").trim();
    if (!this.key) throw new Error("The summaries API key file is empty");
  }
  get model() { return this.config.model; }

  /** One request per distinct message range; concurrent callers share it. */
  summarize(sessionId: string, messages: ChatMessage[], from: string, to: string): Promise<Summary> {
    const key = `${sessionId}:${from}:${to}`;
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const task = this.request(messages, from, to).then(summary => {
      this.cache.set(key, summary);
      if (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
      return summary;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async request(messages: ChatMessage[], from: string, to: string): Promise<Summary> {
    const at = new Date().toISOString();
    if (!messages.length) return { model: this.config.model, text: "", from, to, messages: 0, at };
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl.replace(/\/$/, "")}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: this.config.model, instructions: INSTRUCTIONS, input: transcriptText(messages), max_output_tokens: 600, store: false }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new SummaryError(`The summary model could not be reached: ${(error as Error).message}`);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = (body as { error?: { message?: unknown } })?.error?.message;
      throw new SummaryError(`The summary model refused the request (${response.status})${typeof detail === "string" ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    const text = responseText(body);
    if (!text) throw new SummaryError("The summary model returned no text");
    return { model: this.config.model, text, from, to, messages: messages.length, at };
  }
}
