import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { TeamCheck } from "./team-types.js";

export interface CheckFailure { line: string; detail: string }
export interface CheckScan { bytes: number; failureCount: number; failures: CheckFailure[] }

// PROPOSED: failures kept per scan; the rest are counted only.
const KEEP_FAILURES = 8;
// PROPOSED: detail lines kept for one failure.
const DETAIL_LINES = 30;
// PROPOSED: detail bytes kept for one failure.
const DETAIL_BYTES = 1500;
// PROPOSED: one cleaned line is cut to this many bytes.
const LINE_BYTES = 240;
// PROPOSED: the longest unfinished line held per stream.
const PENDING_BYTES = 4096;
// PROPOSED: size limit of the repair feedback text.
const FEEDBACK_BYTES = 12000;
// PROPOSED: least space kept for the end of the kept output.
const END_RESERVE_BYTES = 2000;
// PROPOSED: room kept for the failure heading line.
const FAILURE_HEADING_BYTES = 200;
// PROPOSED: room kept for the end-of-output heading line.
const END_HEADING_BYTES = 120;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const CHECK_MARK = String.fromCodePoint(0x2716);
const CHECK_LINE = new RegExp(`^( *)${CHECK_MARK} `);
const TAP_FAILURE = /^ *not ok/;
const TAP_DIRECTIVE = /#\s+(?:skip|todo)\b/i;

type Stream = "stdout" | "stderr";
type Kind = "tap" | "marker";
/** An open failure whose indented detail is still arriving on one stream. */
interface Open { kind: "wait" | "yaml" | "marker"; failure: CheckFailure; lines: number; bytes: number; indent: number }
interface StreamState { decoder: StringDecoder; pending: string; overflow: boolean; open?: Open }

const fresh = (): StreamState => ({ decoder: new StringDecoder("utf8"), pending: "", overflow: false });
const plain = (line: string) => line.replace(ANSI, "");
const indentOf = (line: string) => line.match(/^ */)![0].length;

/** Cut to at most `bytes` bytes, on a character boundary. */
function cut(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let out = "", used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes) break;
    out += char; used += size;
  }
  return out;
}

function clean(line: string): string {
  return cut(plain(line).replace(CONTROL, " "), LINE_BYTES);
}

function failureKind(text: string): Kind | undefined {
  if (TAP_FAILURE.test(text)) return TAP_DIRECTIVE.test(text) ? undefined : "tap";
  const marker = CHECK_LINE.exec(text);
  if (!marker) return undefined;
  return text.slice(marker[0].length).trim().toLowerCase() === "failing tests:" ? undefined : "marker";
}

/** Streaming scan of command output. Memory is bounded by the kept failures, one pending line per stream and the distinct-failure hashes. */
export class CheckOutputScanner {
  private readonly streams: Record<Stream, StreamState> = { stdout: fresh(), stderr: fresh() };
  private readonly seen = new Set<string>();
  private readonly kept: CheckFailure[] = [];
  private count = 0;
  private bytes = 0;

  push(chunk: Buffer, stream: Stream): void {
    const state = this.streams[stream];
    this.bytes += chunk.length;
    this.consume(state, state.decoder.write(chunk));
  }

  finish(): CheckScan {
    for (const state of Object.values(this.streams)) {
      this.consume(state, state.decoder.end());
      if (state.pending) this.line(state, state.pending);
      state.pending = ""; state.overflow = false; state.open = undefined;
    }
    return { bytes: this.bytes, failureCount: this.count, failures: this.kept.map(failure => ({ ...failure })) };
  }

  private consume(state: StreamState, text: string): void {
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      this.append(state, text.slice(start, end));
      this.line(state, state.pending);
      state.pending = ""; state.overflow = false;
      start = end + 1;
    }
    this.append(state, text.slice(start));
  }

  private append(state: StreamState, part: string): void {
    if (state.overflow || !part) return;
    state.pending += part;
    if (Buffer.byteLength(state.pending) > PENDING_BYTES) { state.pending = cut(state.pending, PENDING_BYTES); state.overflow = true; }
  }

  private line(state: StreamState, raw: string): void {
    const text = plain(raw);
    const kind = failureKind(text);
    if (kind) { state.open = undefined; this.failure(state, text, kind); return; }
    if (state.open) this.feed(state, state.open, text);
  }

  private failure(state: StreamState, text: string, kind: Kind): void {
    const line = clean(text);
    const key = createHash("sha256").update(line).digest("hex").slice(0, 16);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.count++;
    if (this.kept.length >= KEEP_FAILURES) return;
    const failure: CheckFailure = { line, detail: "" };
    this.kept.push(failure);
    state.open = { kind: kind === "tap" ? "wait" : "marker", failure, lines: 0, bytes: 0, indent: indentOf(text) };
  }

  private feed(state: StreamState, open: Open, text: string): void {
    if (open.kind === "wait") {
      if (text.trim() !== "---") { state.open = undefined; return; }
      open.kind = "yaml";
    } else if (open.kind === "marker" && (!text.trim() || indentOf(text) <= open.indent)) {
      state.open = undefined; return;
    }
    const line = clean(text), cost = Buffer.byteLength(line) + 1;
    if (open.lines >= DETAIL_LINES || open.bytes + cost > DETAIL_BYTES) { state.open = undefined; return; }
    open.failure.detail += (open.lines ? "\n" : "") + line;
    open.lines++; open.bytes += cost;
    if (open.kind === "yaml" && text.trim() === "...") state.open = undefined;
  }
}

/** The same scan over one string. */
export function scanCheckOutput(text: string): CheckScan {
  const scanner = new CheckOutputScanner();
  scanner.push(Buffer.from(text, "utf8"), "stdout");
  return scanner.finish();
}

const size = (rows: readonly string[]) => rows.reduce((total, row) => total + Buffer.byteLength(row) + 1, 0);
const failureBlock = (failure: CheckFailure) => [`  ${failure.line}`, ...(failure.detail ? failure.detail.split("\n").map(row => `    ${row}`) : [])];
const FOOTER = 'The kept output of each check is in the context file under "checks".';

/** Repair feedback for the integrator: the failing tests first, then the end of the kept output. Never more than FEEDBACK_BYTES. */
export function checkFeedback(checks: readonly TeamCheck[]): string {
  const index = checks.findIndex(check => check.status !== "passed");
  const at = Math.max(index, 0), failed = checks[at];
  if (!failed) return "Configured verification failed: no check result was recorded.";
  const head = [`Configured verification failed: check ${at + 1} of ${checks.length} did not pass.`];
  checks.forEach((check, position) => {
    head.push(`Check ${position + 1}: ${check.status}, exit ${check.exitCode ?? "none"}, command ${clean([check.command.command, ...check.command.args].join(" "))}.`);
  });
  const scan = failed.scan ?? scanCheckOutput(failed.output);
  const kept = Buffer.byteLength(failed.output);
  head.push(`The command wrote ${scan.bytes} bytes.${scan.bytes > kept ? ` The host kept only the last ${kept} bytes.` : ""}`);
  const limit = FEEDBACK_BYTES - size(head) - size([FOOTER]) - END_RESERVE_BYTES - FAILURE_HEADING_BYTES;
  const shown: string[] = [];
  let blocks = 0, used = 0;
  for (const failure of scan.failures) {
    const block = failureBlock(failure);
    if (used + size(block) > limit) break;
    shown.push(...block); used += size(block); blocks++;
  }
  const failures = [`The host found ${scan.failureCount} failing tests and shows ${blocks} of them (parsed from the output, not interpreted).`];
  const rows = failed.output.endsWith("\n") ? failed.output.slice(0, -1).split("\n") : failed.output ? failed.output.split("\n") : [];
  const room = FEEDBACK_BYTES - size(head) - size(failures) - size(shown) - size([FOOTER]) - END_HEADING_BYTES;
  const tail: string[] = [];
  let tailBytes = 0;
  for (let row = rows.length - 1; row >= 0; row--) {
    const cleaned = clean(rows[row]!);
    if (tailBytes + Buffer.byteLength(cleaned) + 1 > room) break;
    tail.unshift(cleaned); tailBytes += Buffer.byteLength(cleaned) + 1;
  }
  const end = tail.length ? [`The last ${Buffer.byteLength(tail.join("\n"))} bytes of the kept output follow, cut on a line boundary:`, ...tail] : [];
  return [...head, ...failures, ...shown, ...end, FOOTER].join("\n");
}
