import { createHash } from "node:crypto";

// Parsers for the runner reports that validation reads (JUnit XML and TAP 13/14). Pure: no I/O, no dependency.
// The reports are written by the grader account, so every limit holds, and a report that breaks one is invalid.
// Each parser runs in one pass over the text, and no work grows faster than linearly in the report size.

export const REPORT_MAX_BYTES = 8_388_608,
  REPORT_CASES_MAX = 20_000,
  CASE_KEY_MAX = 4_096,
  TAP_LINES_MAX = 200_000,
  TAP_LINE_MAX = 16_384;

export type CaseStatus = "passed" | "failed" | "skipped";
export type ParsedReport = { state: "parsed"; cases: ReadonlyMap<string, CaseStatus> } | { state: "invalid" };

const INVALID: ParsedReport = { state: "invalid" };
const NUL = "\0";
const RANK: Record<CaseStatus, number> = { passed: 0, skipped: 1, failed: 2 };
const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);
const RESULT_LINE = /^(not ok|ok)(?: (\d+))?(?: - (.*))?$/;
const DIRECTIVE = /\s#\s*(SKIP|TODO)\b/i;
const PLAN_LINE = /^1\.\.(\d+)$/;
const SUBTEST_PREFIX = "# Subtest: ";

type Collector = { cases: Map<string, CaseStatus>; seen: number };

/** Parses one report. Keys in the result are SHA-256 hex of the case key; a repeated key keeps its worse status. */
export function parseReport(format: "junit" | "tap", bytes: Buffer): ParsedReport {
  if (bytes.length > REPORT_MAX_BYTES) return INVALID;
  const text = bytes.toString("utf8");
  const collector: Collector = { cases: new Map(), seen: 0 };
  const wellFormed = format === "junit" ? parseJunit(text, collector) : parseTap(text, collector);
  return wellFormed ? { state: "parsed", cases: collector.cases } : INVALID;
}

/** The stored form of a raw case key: its SHA-256 hex, the same key `parseReport` uses in its map. */
export function caseRef(key: string): string {
  return sha256(key);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Records one case occurrence. Returns false past the case limit.
function addCase(collector: Collector, key: string, status: CaseStatus): boolean {
  collector.seen += 1;
  if (collector.seen > REPORT_CASES_MAX) return false;
  const hashed = sha256(key);
  const previous = collector.cases.get(hashed);
  if (previous === undefined || RANK[status] > RANK[previous]) collector.cases.set(hashed, status);
  return true;
}

// The names of the enclosing suites. Running lengths keep each key check O(1) before anything is joined.
class Path {
  private readonly names: string[] = [];
  private readonly totals: number[] = [0];

  push(name: string): void {
    const count = this.names.length;
    this.names.push(name);
    this.totals.push(this.totals[count] + (count > 0 ? 1 : 0) + name.length);
  }

  pop(): void {
    this.names.pop();
    this.totals.pop();
  }

  /** The NUL-joined key of the path followed by `last`, or null when it would exceed the key limit. */
  keyWith(...last: string[]): string | null {
    const count = this.names.length;
    let length = this.totals[count];
    for (let i = 0; i < last.length; i += 1) length += (count + i > 0 ? 1 : 0) + last[i].length;
    if (length > CASE_KEY_MAX) return null;
    return [...this.names, ...last].join(NUL);
  }
}

// ---- JUnit ----

type OpenCase = { name: string; classname: string; status: CaseStatus };

function parseJunit(text: string, collector: Collector): boolean {
  // A DTD or an entity declaration makes the report invalid, wherever it appears.
  if (text.includes("<!DOCTYPE") || text.includes("<!ENTITY")) return false;

  const open: string[] = [];
  const suites = new Path();
  let testcase: OpenCase | null = null;
  let rootSeen = false;
  let at = 0;

  const record = (tc: OpenCase): boolean => {
    const key = suites.keyWith(tc.classname, tc.name);
    return key !== null && addCase(collector, key, tc.status);
  };

  for (;;) {
    const lt = text.indexOf("<", at);
    if (lt === -1) break;
    at = lt;

    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) return false;
      at = end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end === -1) return false;
      at = end + 2;
      continue;
    }
    // A DOCTYPE, a CDATA section, or any other declaration is not part of the report format.
    if (text.startsWith("<!", lt)) return false;

    if (text.startsWith("</", lt)) {
      const end = text.indexOf(">", lt);
      if (end === -1) return false;
      const name = text.slice(lt + 2, end).trim();
      at = end + 1;
      if (open.pop() !== name) return false;
      if (name === "testsuite") suites.pop();
      if (name === "testcase") {
        if (testcase === null || !record(testcase)) return false;
        testcase = null;
      }
      continue;
    }

    const tagEnd = findTagEnd(text, lt + 1);
    if (tagEnd === -1) return false;
    let body = text.slice(lt + 1, tagEnd);
    at = tagEnd + 1;
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1);
    const nameMatch = /^[^\s/]+/.exec(body);
    if (nameMatch === null) return false;
    const name = nameMatch[0];
    const attrs = parseAttributes(body.slice(name.length));
    if (attrs === null) return false;

    if (open.length === 0 && rootSeen) return false;
    rootSeen = true;
    const parent = open[open.length - 1];
    if (!selfClosing) open.push(name);

    if (name === "testsuite") {
      const suite = attrs.get("name") ?? "";
      if (suite.includes(NUL)) return false;
      if (!selfClosing) suites.push(suite);
    } else if (name === "testcase") {
      if (testcase !== null) return false;
      const tc: OpenCase = {
        name: attrs.get("name") ?? "",
        classname: attrs.get("classname") ?? "",
        status: attrs.has("failure") || attrs.has("error") ? "failed" : "passed",
      };
      if (tc.name.includes(NUL) || tc.classname.includes(NUL)) return false;
      if (selfClosing) {
        if (!record(tc)) return false;
      } else {
        testcase = tc;
      }
    } else if ((name === "failure" || name === "error" || name === "skipped") && parent === "testcase" && testcase !== null) {
      const status: CaseStatus = name === "skipped" ? "skipped" : "failed";
      if (RANK[status] > RANK[testcase.status]) testcase.status = status;
    }
  }

  return rootSeen && open.length === 0 && testcase === null;
}

// The index of the `>` that closes a tag, skipping quoted attribute values, or -1.
function findTagEnd(text: string, from: number): number {
  let quote = 0;
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if (code === 34 || code === 39) {
      quote = code;
    } else if (code === 62) {
      return i;
    }
  }
  return -1;
}

// Attributes of a tag body, with their values decoded. Null when the syntax is broken.
function parseAttributes(body: string): Map<string, string> | null {
  const attrs = new Map<string, string>();
  const n = body.length;
  let i = 0;
  for (;;) {
    while (i < n && isSpace(body.charCodeAt(i))) i += 1;
    if (i >= n) return attrs;
    const nameStart = i;
    while (i < n && !isSpace(body.charCodeAt(i)) && body.charCodeAt(i) !== 61) i += 1;
    const attrName = body.slice(nameStart, i);
    if (attrName === "") return null;
    while (i < n && isSpace(body.charCodeAt(i))) i += 1;
    if (body.charCodeAt(i) !== 61) return null;
    i += 1;
    while (i < n && isSpace(body.charCodeAt(i))) i += 1;
    const quote = body.charCodeAt(i);
    if (quote !== 34 && quote !== 39) return null;
    const end = body.indexOf(body[i], i + 1);
    if (end === -1) return null;
    const raw = body.slice(i + 1, end);
    if (raw.includes("<")) return null;
    const value = decodeText(raw);
    if (value === null) return null;
    attrs.set(attrName, value);
    i = end + 1;
  }
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

// Decodes the five named entities and numeric references. Anything else, or a code point XML forbids, is null.
function decodeText(raw: string): string | null {
  if (!raw.includes("&")) return raw;
  let out = "";
  let at = 0;
  for (;;) {
    const amp = raw.indexOf("&", at);
    if (amp === -1) return out + raw.slice(at);
    out += raw.slice(at, amp);
    const semi = raw.slice(amp, amp + 12).indexOf(";");
    if (semi === -1) return null;
    const decoded = decodeEntity(raw.slice(amp + 1, amp + semi));
    if (decoded === null) return null;
    out += decoded;
    at = amp + semi + 1;
  }
}

function decodeEntity(entity: string): string | null {
  const named = NAMED_ENTITIES.get(entity);
  if (named !== undefined) return named;
  const numeric = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(entity);
  if (numeric === null) return null;
  const code = numeric[1] !== undefined ? parseInt(numeric[1], 16) : Number(numeric[2]);
  if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  return String.fromCodePoint(code);
}

// ---- TAP ----

type TapFrame = { indent: number; children: boolean };

function parseTap(text: string, collector: Collector): boolean {
  const lines = text.split("\n");
  if (lines.length > TAP_LINES_MAX) return false;

  const path = new Path();
  const frames: TapFrame[] = [];
  let yamlIndent = -1;
  let afterResult = false;
  let topLevelResults = 0;
  let plan = -1;

  for (const raw of lines) {
    if (raw.length > TAP_LINE_MAX) return false;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    let indent = 0;
    while (indent < line.length && line.charCodeAt(indent) === 32) indent += 1;
    const body = line.slice(indent);

    // A YAML diagnostic block belongs to the result line before it, and is skipped whole.
    if (yamlIndent >= 0) {
      if (indent === yamlIndent && body === "...") yamlIndent = -1;
      continue;
    }
    if (afterResult && body === "---") {
      yamlIndent = indent;
      afterResult = false;
      continue;
    }
    afterResult = false;

    if (body.startsWith(SUBTEST_PREFIX)) {
      while (frames.length > 0 && frames[frames.length - 1].indent >= indent) {
        frames.pop();
        path.pop();
      }
      const parentFrame = frames[frames.length - 1];
      if (parentFrame !== undefined) parentFrame.children = true;
      const name = body.slice(SUBTEST_PREFIX.length);
      if (name.includes(NUL)) return false;
      frames.push({ indent, children: false });
      path.push(name);
      continue;
    }

    const result = RESULT_LINE.exec(body);
    if (result !== null) {
      let description = result[3] ?? "";
      const directive = DIRECTIVE.exec(description);
      if (directive !== null) description = description.slice(0, directive.index);
      if (description.includes(NUL)) return false;
      afterResult = true;
      if (indent === 0) topLevelResults += 1;

      while (frames.length > 0 && frames[frames.length - 1].indent > indent) {
        frames.pop();
        path.pop();
      }
      let isSuite = false;
      const own = frames[frames.length - 1];
      if (own !== undefined && own.indent === indent) {
        frames.pop();
        path.pop();
        isSuite = own.children;
      }
      if (isSuite) continue;

      const key = path.keyWith(description);
      if (key === null) return false;
      const status: CaseStatus = directive !== null ? "skipped" : result[1] === "not ok" ? "failed" : "passed";
      if (!addCase(collector, key, status)) return false;
      continue;
    }

    const planLine = indent === 0 ? PLAN_LINE.exec(body) : null;
    if (planLine !== null) {
      if (plan !== -1) return false;
      plan = Number(planLine[1]);
    }
  }

  // A well-formed report closes every subtest and states a plan that counts its top-level results.
  return frames.length === 0 && plan !== -1 && plan === topLevelResults;
}
