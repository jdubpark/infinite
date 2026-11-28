import type { PromptKind, PromptOption, Provider } from "./types.js";
import { roleForLabel } from "./roles.js";
import { accountSettingPrompt } from "./delegation.js";

export interface DetectedPrompt {
  kind: PromptKind;
  title: string;
  detail?: string;
  options: PromptOption[];
  highlighted?: number;
  acceptsText: boolean;
  multiSelect: boolean;
  pinned: boolean;
  fingerprint: string;
  blockStart: number;
  blockEnd: number;
}

const OPTION = /^([❯›>]\s*)?(\d{1,2})\.\s+(.+?)$/;
const RULE = /^[\s─━═│┃┌┐└┘├┤╭╮╰╯\-_=*·]*$/;
const BOX_TOP = /[╭┌]/;
const PERMISSION = /do you want to (proceed|make this edit|create|run)|would you like to (run|make)|approve network access|needs your approval|permission/i;
const HEADER_TITLE = /^would you like to (run|make) .*\?$/i;
const HEADER_LIMIT = 12;
const DETAIL_LIMIT = 2000;
const QUESTION_OPTION = /^(chat about this|other|skip|type something|yes,\s*implement this plan|no,\s*stay in plan mode)/i;
const MULTI = /a to select all|n to select none/i;
const YES_NO = /(\[(y\/N|Y\/n|y\/n)\]|\((y\/n|yes\/no)\))\s*:?\s*$/i;
const KEY_HINT = /^(Enter to|Esc to|Press )/i;
const CODE_MODE_FOOTER = /^(Tellushowitgoeswith\/feedback)?(Entertoconfirm·?Esctostartwithoutit)?$/i;

export function normalisedLines(text?: string): string[] {
  return (text ?? "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function cleanLine(line: string): string {
  return line.replace(/^[\s│┃]+|[\s│┃]+$/g, "");
}

export function detectPrompt(lines: string[], provider: Provider): DetectedPrompt | null {
  const clean = lines.map(cleanLine);
  const codeMode = detectCodeModeConfirmation(clean);
  if (codeMode) return codeMode;
  const block = lastOptionBlock(clean, lines);
  if (block) {
    const { start, end, options, highlighted } = block;
    const above: string[] = [];
    for (let i = start - 1; i >= 0 && above.length < HEADER_LIMIT; i--) {
      if (OPTION.test(clean[i]) || BOX_TOP.test(clean[i])) break;
      if (clean[i] === "" || RULE.test(clean[i])) continue;
      above.unshift(clean[i]);
      if (HEADER_TITLE.test(clean[i])) break;
    }
    const headerTitle = above.findIndex((l) => HEADER_TITLE.test(l));
    const permissionQuestion = findLastIndex(above, (l) => l.endsWith("?") && PERMISSION.test(l));
    const titleIndex = headerTitle >= 0 ? headerTitle : permissionQuestion >= 0 ? permissionQuestion : findLastIndex(above, (l) => l.endsWith("?"));
    const title = titleIndex >= 0 ? above[titleIndex] : above.at(-1) ?? "";
    const detailLines = above.filter((_, i) => i !== titleIndex && above[i] !== title);
    const detail = boundedDetail(detailLines);
    const footer = clean.slice(end + 1, end + 3).join(" ");
    const multiSelect = MULTI.test(footer);
    const pinned = pinnedAfter(clean, end);
    let kind: PromptKind = "menu";
    if (PERMISSION.test(title)) kind = "permission";
    else if (options.some((o) => QUESTION_OPTION.test(o.label))) kind = "question";
    const acceptsText = options.some((o) => o.role === "reject-with-feedback");
    return {
      kind, title, detail, options, highlighted, acceptsText, multiSelect, pinned,
      fingerprint: [title, ...normalisedLines(detail), ...options.map((o) => o.label)].join("\n"),
      blockStart: start, blockEnd: end,
    };
  }
  const trust = detectWorkspaceTrust(clean);
  if (trust) return trust;
  const lastIndex = findLastIndex(clean, (l) => l !== "");
  if (lastIndex >= 0 && YES_NO.test(clean[lastIndex])) {
    const title = clean[lastIndex];
    return {
      kind: "yes-no", title, options: [
        { index: 0, label: "Yes", role: "accept" },
        { index: 1, label: "No", role: "reject" },
      ],
      acceptsText: true, multiSelect: false, pinned: true, fingerprint: title,
      blockStart: lastIndex, blockEnd: lastIndex,
    };
  }
  void provider;
  return null;
}

function lastOptionBlock(clean: string[], raw: string[]) {
  const firstTextCol = (line: string) => line.search(/[^\s│┃]/);
  const numberCol = (line: string) => line.search(/\d{1,2}\.\s/);
  let best: { start: number; end: number; options: PromptOption[]; highlighted?: number } | null = null;
  let i = 0;
  while (i < clean.length) {
    const m = OPTION.exec(clean[i]);
    if (!m || Number(m[2]) !== 1) { i++; continue; }
    const options: PromptOption[] = [];
    let highlighted: number | undefined;
    let j = i;
    let expected = 1;
    let optionCol = numberCol(raw[i]);
    while (j < clean.length) {
      const om = OPTION.exec(clean[j]);
      if (om && Number(om[2]) === expected) {
        if (om[1]) highlighted = options.length;
        optionCol = numberCol(raw[j]);
        options.push({ index: options.length, label: om[3].trim(), role: "other" });
        expected++;
        j++;
      } else if (options.length && clean[j] !== "" && !om && firstTextCol(raw[j]) > optionCol && !clean[j].endsWith("?") && !MULTI.test(clean[j]) && !KEY_HINT.test(clean[j])) {
        options[options.length - 1].label += " " + clean[j].trim();
        j++;
      } else break;
    }
    if (options.length >= 2 && highlighted !== undefined) {
      for (const o of options) o.role = roleForLabel(o.label);
      best = { start: i, end: j - 1, options, highlighted };
    }
    i = Math.max(j, i + 1);
  }
  return best;
}

function compact(line: string): string {
  return line.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function boundedDetail(lines: string[]): string | undefined {
  if (!lines.length) return undefined;
  const joined = lines.join("\n");
  return joined.length > DETAIL_LIMIT ? `${joined.slice(0, DETAIL_LIMIT)}… [+${joined.length - DETAIL_LIMIT} chars]` : joined;
}

function pinnedAfter(clean: string[], end: number): boolean {
  return clean.slice(end + 1).every(line => line === "" || RULE.test(line) || KEY_HINT.test(line));
}

function compactedOptionAt(clean: string[], start: number, expected: string) {
  let accumulated = "";
  for (let end = start; end < Math.min(clean.length, start + 4); end++) {
    const part = compact(clean[end].replace(/^[❯›>]\s*/, "").trim());
    if (!part || !expected.startsWith(accumulated + part)) return undefined;
    accumulated += part;
    if (accumulated === expected) {
      const line = clean[start];
      return { start, end, highlighted: line.includes("❯") || line.includes("›") || line.trimStart().startsWith(">") };
    }
  }
  return undefined;
}

function detectCodeModeConfirmation(clean: string[]): DetectedPrompt | null {
  const titleIndex = findLastIndex(clean, line => accountSettingPrompt({ title: line }));
  if (titleIndex < 0) return null;
  let firstOption: ReturnType<typeof compactedOptionAt>;
  let secondOption: ReturnType<typeof compactedOptionAt>;
  let firstRole: "reject" | "accept" | undefined;
  for (let start = titleIndex + 1; start < clean.length; start++) {
    const noFirst = compactedOptionAt(clean, start, "nostartwithoutit");
    const yesFirst = noFirst ? undefined : compactedOptionAt(clean, start, "yesturnoncodemode");
    const first = noFirst ?? yesFirst;
    if (!first) continue;
    const otherRole = noFirst ? "accept" : "reject";
    const second = compactedOptionAt(clean, first.end + 1, otherRole === "accept" ? "yesturnoncodemode" : "nostartwithoutit");
    if (!second) continue;
    const tail = clean.slice(second.end + 1).filter(line => !RULE.test(line)).join("").replace(/\s+/g, "");
    if (!CODE_MODE_FOOTER.test(tail)) continue;
    firstOption = first;
    secondOption = second;
    firstRole = noFirst ? "reject" : "accept";
    break;
  }
  if (!firstOption || !secondOption || firstOption.highlighted === secondOption.highlighted) return null;
  const end = secondOption.end;
  const options = firstRole === "reject"
    ? [
        { index: 0, label: "No, start without it", role: "reject" as const },
        { index: 1, label: "Yes, turn on Code Mode", role: "accept" as const },
      ]
    : [
        { index: 0, label: "Yes, turn on Code Mode", role: "accept" as const },
        { index: 1, label: "No, start without it", role: "reject" as const },
      ];
  const marked = firstOption.highlighted ? 0 : 1;
  const detailLines = clean.slice(titleIndex + 1, firstOption.start).filter(line => line !== "" && !RULE.test(line));
  const detail = boundedDetail(detailLines);
  return {
    kind: "permission",
    title: clean[titleIndex],
    detail,
    options,
    highlighted: marked,
    acceptsText: false,
    multiSelect: false,
    pinned: true,
    fingerprint: [clean[titleIndex], ...normalisedLines(detail), ...options.map(option => option.label)].join("\n"),
    blockStart: firstOption.start,
    blockEnd: end,
  };
}

function detectWorkspaceTrust(clean: string[]): DetectedPrompt | null {
  let yes = -1;
  let no = -1;
  for (let i = 0; i < clean.length; i++) {
    const text = compact(clean[i]);
    if (text === "yesitrustthisfolder") yes = i;
    if (text === "noexit") no = i;
  }
  if (yes < 0 || no < 0) return null;
  const question = findLastIndex(clean, (line) => compact(line).includes("isthisaprojectyoucreatedoroneyoutrust"));
  if (question < 0) return null;
  const start = Math.min(yes, no);
  const end = Math.max(yes, no);
  const paths = clean.slice(0, start).filter((line) => line.startsWith("/"));
  const detail = paths.length ? paths.join("\n").slice(0, 2000) : undefined;
  const noFirst = no < yes;
  const options: PromptOption[] = noFirst
    ? [
        { index: 0, label: "No, exit", role: "reject" },
        { index: 1, label: "Yes, I trust this folder", role: "accept" },
      ]
    : [
        { index: 0, label: "Yes, I trust this folder", role: "accept" },
        { index: 1, label: "No, exit", role: "reject" },
      ];
  const marked = clean[yes].includes("❯") || clean[yes].trimStart().startsWith(">") ? options.find((option) => option.role === "accept")!.index
    : options.find((option) => option.role === "reject")!.index;
  const title = clean[question];
  return {
    kind: "permission",
    title,
    detail,
    options,
    highlighted: marked,
    acceptsText: false,
    multiSelect: false,
    pinned: pinnedAfter(clean, end),
    fingerprint: [title, ...normalisedLines(detail), ...options.map((option) => option.label)].join("\n"),
    blockStart: start,
    blockEnd: end,
  };
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return -1;
}

export function isIdleScreen(lines: string[], provider: Provider): boolean {
  const clean = lines.map(cleanLine);
  const lastIndex = findLastIndex(clean, (l) => l !== "" && !RULE.test(l) && !/^\?\s*for shortcuts/i.test(l));
  if (lastIndex < 0) return false;
  const last = clean[lastIndex];
  if (provider === "claude" || provider === "codex") return /^[>›❯]\s*$/.test(last);
  return /^(\S+\s*)?[$%>#]\s*$/.test(last);
}
