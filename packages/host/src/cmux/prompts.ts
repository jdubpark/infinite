import { createHash } from "node:crypto";
import { blockDestructive, detectPrompt, type Prompt } from "@infinite/attention";
import { array, object, string, CmuxError, type Json } from "./client.js";
import type { CmuxProvider } from "./discovery.js";

export interface PendingPrompt {
  prompt: Omit<Prompt, "id">;
  fingerprint: string;
  feed?: Json;
}

export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function workstreamKey(value: unknown): string | undefined {
  const parts = string(value)?.split(":");
  if (parts?.length !== 3 || parts[0] !== "cmux-feed-v1") return undefined;
  return `${Buffer.from(parts[1], "base64").toString("utf8")}:${Buffer.from(parts[2], "base64").toString("utf8")}`;
}

export function matchingFeed(rows: Json[], session: { provider: CmuxProvider; nativeId?: string; surfaceId?: string }): Json | undefined {
  return rows.find((row) => {
    if (!string(row.request_id) || (row.status && row.status !== "pending")) return false;
    const key = workstreamKey(row.workstream_id) ?? (row.source && row.session_id ? `${row.source}:${row.session_id}` : undefined);
    // A known native identity wins; a reused surface cannot inherit an old approval.
    if (key && session.nativeId) return key === `${session.provider}:${session.nativeId}`;
    return Boolean(session.surfaceId && row.surface_id === session.surfaceId && (!row.source || row.source === session.provider));
  });
}

function questions(row: Json): Json[] {
  return Array.isArray(row.questions) && row.questions.length
    ? array(row.questions)
    : [{ prompt: row.question_prompt ?? "Question", options: row.question_options ?? [], multi_select: row.question_multi_select === true }];
}

export function pendingPrompt(provider: CmuxProvider, screen: string, feed?: Json): PendingPrompt | undefined {
  if (feed) {
    const kind = String(feed.kind ?? "").toLowerCase();
    const detail = typeof feed.tool_input === "string" ? feed.tool_input : feed.tool_input ? JSON.stringify(feed.tool_input, null, 2) : string(feed.plan) ?? string(feed.text) ?? "";
    let prompt: Omit<Prompt, "id">;
    if (kind.includes("permission")) {
      prompt = {
        kind: "permission", title: string(feed.tool_name) ?? string(feed.title) ?? "Permission requested",
        detail: detail.slice(0, 8000), acceptsText: false, source: "protocol",
        options: [
          { index: 0, label: "Allow once", role: "accept" },
          { index: 1, label: "Always allow", role: "accept-always" },
          { index: 2, label: "Deny", role: "reject" },
        ],
      };
    } else if (kind.includes("plan")) {
      prompt = {
        kind: "permission", title: string(feed.title) ?? "Review plan", detail: detail.slice(0, 8000),
        acceptsText: true, source: "protocol",
        options: [
          { index: 0, label: "Proceed with manual approvals", role: "accept" },
          { index: 1, label: "Proceed with automatic approvals", role: "accept-always" },
          { index: 2, label: "Reject with feedback", role: "reject-with-feedback" },
        ],
      };
    } else if (kind.includes("question")) {
      const items = questions(feed);
      const single = items.length === 1;
      const q = items[0];
      const multiple = q.multi_select === true || q.multiSelect === true;
      prompt = {
        kind: "question", title: single ? string(q.prompt) ?? string(q.question) ?? "Question" : `Answer ${items.length} questions`,
        detail: single ? detail.slice(0, 8000) : items.map((item, i) => `${i + 1}. ${item.prompt ?? item.question ?? "Question"}`).join("\n") + "\nEnter one answer per line in the same order.",
        acceptsText: true, multiSelect: multiple, source: "protocol",
        options: single && !multiple ? array(q.options).map((option, index) => ({ index, label: string(option.label) ?? string(option.id) ?? `Option ${index + 1}`, role: "other" })) : [],
      };
    } else return undefined;
    const fingerprint = digest({ request: feed.request_id, kind: feed.kind, prompt, questions: questions(feed), tool: feed.tool_input, plan: feed.plan, text: feed.text });
    return { prompt: { ...prompt, hash: fingerprint, destructive: blockDestructive(prompt) }, fingerprint, feed };
  }
  const detected = detectPrompt(screen.split("\n"), provider);
  if (!detected) return undefined;
  const { fingerprint: block, blockStart: _start, blockEnd: _end, ...prompt } = detected;
  const fingerprint = digest(block);
  return { prompt: { ...prompt, hash: fingerprint, source: "screen", destructive: blockDestructive(prompt) }, fingerprint };
}

/** This only translates an explicit person's answer; no default ever accepts. */
export function feedReply(feed: Json, option?: number, text?: string): { method: string; params: Json } {
  const kind = String(feed.kind ?? "").toLowerCase();
  const params: Json = { request_id: feed.request_id };
  if (kind.includes("permission")) {
    if (text !== undefined || option === undefined || ![0, 1, 2].includes(option)) throw new CmuxError("invalid-option");
    return { method: "feed.permission.reply", params: { ...params, mode: ["once", "always", "deny"][option] } };
  }
  if (kind.includes("plan")) {
    if (option === undefined && text?.trim()) option = 2;
    if (option === undefined || ![0, 1, 2].includes(option) || (text !== undefined && option !== 2)) throw new CmuxError("invalid-option");
    return { method: "feed.exit_plan.reply", params: { ...params, mode: ["manual", "auto", "deny"][option], ...(text ? { feedback: text } : {}) } };
  }
  if (kind.includes("question")) {
    const items = questions(feed);
    if (option !== undefined && text !== undefined) throw new CmuxError("invalid-option");
    let selections: string[];
    if (option !== undefined) {
      const q = items[0];
      const chosen = array(q.options)[option];
      if (items.length !== 1 || q.multi_select || q.multiSelect || !chosen) throw new CmuxError("invalid-option");
      selections = [string(chosen.label) ?? string(chosen.id) ?? ""];
    } else selections = items.length === 1 ? [text ?? ""] : (text ?? "").split("\n");
    if (selections.length !== items.length || selections.some((value) => !value.trim())) throw new CmuxError("text-not-accepted");
    return { method: "feed.question.reply", params: { ...params, selections } };
  }
  throw new CmuxError("unsupported");
}
