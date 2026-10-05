import type { PromptKind, PromptOption, Provider } from "./types.js";
import { roleForLabel } from "./roles.js";

export interface DetectedPrompt {
  kind: PromptKind;
  title: string;
  detail?: string;
  options: PromptOption[];
  highlighted?: number;
  acceptsText: boolean;
  multiSelect: boolean;
  fingerprint: string;
  blockStart: number;
  blockEnd: number;
}

const OPTION = /^([❯›>]\s*)?(\d{1,2})\.\s+(.+?)$/;
const RULE = /^[\s─━═│┃┌┐└┘├┤╭╮╰╯\-_=*·]*$/;
const BOX_TOP = /[╭┌]/;
const PERMISSION = /do you want to (proceed|make this edit|create|run)|would you like to (run|make)|approve network access|needs your approval|permission/i;
const QUESTION_OPTION = /^(chat about this|other|skip|type something)/i;
const MULTI = /a to select all|n to select none/i;
const YES_NO = /(\[(y\/N|Y\/n|y\/n)\]|\((y\/n|yes\/no)\))\s*:?\s*$/i;

/** The non-empty lines of `text`, each with its whitespace runs collapsed to one space. */
export function normalisedLines(text?: string): string[] {
  return (text ?? "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Strip box-drawing borders and surrounding whitespace. */
export function cleanLine(line: string): string {
  return line.replace(/^[\s│┃]+|[\s│┃]+$/g, "");
}

export function detectPrompt(lines: string[], provider: Provider): DetectedPrompt | null {
  const clean = lines.map(cleanLine);
  const block = lastOptionBlock(clean, lines);
  if (block) {
    const { start, end, options, highlighted } = block;
    const above: string[] = [];
    for (let i = start - 1; i >= 0 && above.length < 6; i--) {
      // A box's top edge ends the dialog: transcript lines above it are not its header.
      if (OPTION.test(clean[i]) || BOX_TOP.test(clean[i])) break;
      if (clean[i] === "" || RULE.test(clean[i])) continue;
      above.unshift(clean[i]);
    }
    const titleIndex = findLastIndex(above, (l) => l.endsWith("?"));
    const title = titleIndex >= 0 ? above[titleIndex] : above.at(-1) ?? "";
    const detailLines = above.filter((_, i) => i !== titleIndex && above[i] !== title);
    const detail = detailLines.length ? detailLines.join("\n").slice(0, 2000) : undefined;
    const footer = clean.slice(end + 1, end + 3).join(" ");
    const multiSelect = MULTI.test(footer);
    let kind: PromptKind = "menu";
    if (PERMISSION.test(title)) kind = "permission";
    else if (options.some((o) => QUESTION_OPTION.test(o.label))) kind = "question";
    const acceptsText = options.some((o) => o.role === "reject-with-feedback");
    return {
      kind, title, detail, options, highlighted, acceptsText, multiSelect,
      // The detail (the command, path or question body) is part of the dialog's identity.
      fingerprint: [title, ...normalisedLines(detail), ...options.map((o) => o.label)].join("\n"),
      blockStart: start, blockEnd: end,
    };
  }
  const lastIndex = findLastIndex(clean, (l) => l !== "");
  if (lastIndex >= 0 && YES_NO.test(clean[lastIndex])) {
    const title = clean[lastIndex];
    return {
      kind: "yes-no", title, options: [
        { index: 0, label: "Yes", role: "accept" },
        { index: 1, label: "No", role: "reject" },
      ],
      acceptsText: true, multiSelect: false, fingerprint: title,
      blockStart: lastIndex, blockEnd: lastIndex,
    };
  }
  void provider;
  return null;
}

/**
 * Find the lowest block of consecutively numbered options. A wrapped option label continues on
 * the next line when that raw line is indented past the option number column, is not itself an
 * option, a question, or a key hint. A block counts only when an option carries a selection marker.
 */
function lastOptionBlock(clean: string[], raw: string[]) {
  const firstTextCol = (line: string) => line.search(/[^\s│┃]/);
  const numberCol = (line: string) => line.search(/\d{1,2}\.\s/);
  const KEY_HINT = /^(Enter to|Esc to|Press )/i;
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
