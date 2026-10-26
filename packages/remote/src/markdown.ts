import type { Inline, RichNode } from "./understanding-work.js";

type Options = { maxNodes?: number; maxBytes?: number };
type Marker = { indent: number; ordered: boolean; start: number; width: number; text: string };

const DEFAULT_MAX_NODES = 4000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 32;

/** Bounded CommonMark-subset parser producing rich nodes. Never throws. */
export function parseMarkdown(text: string, options: Options = {}): { nodes: RichNode[]; truncated: boolean } {
  try {
    const safeOptions = options && typeof options === "object" ? options : {};
    const maxNodes = validLimit(safeOptions.maxNodes, DEFAULT_MAX_NODES);
    const maxBytes = validLimit(safeOptions.maxBytes, DEFAULT_MAX_BYTES);
    const source = typeof text === "string" ? text : "";
    const bounded = truncateUtf8(source, maxBytes);
    const parser = new Parser(maxNodes);
    const nodes = parser.blocks(bounded.text.split("\n"));
    return { nodes, truncated: bounded.truncated || parser.truncated };
  } catch {
    return { nodes: [], truncated: true };
  }
}

function validLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > maxBytes) return { text: value.slice(0, end), truncated: true };
    bytes += size;
    end += character.length;
  }
  return { text: value, truncated: false };
}

class Parser {
  private usedNodes = 0;
  truncated = false;
  private exhausted = false;

  constructor(private readonly maxNodes: number) {}

  private reserve(): boolean {
    if (this.usedNodes >= this.maxNodes) {
      this.truncated = true;
      this.exhausted = true;
      return false;
    }
    this.usedNodes += 1;
    return true;
  }

  blocks(lines: string[], depth = 0): RichNode[] {
    if (depth > MAX_DEPTH) {
      if (lines.some((line) => line.trim())) this.truncated = true;
      return [];
    }
    const out: RichNode[] = [];
    let i = 0;
    while (i < lines.length && !this.exhausted) {
      const line = contentLine(lines[i]);
      if (!line.trim()) { i += 1; continue; }

      const fence = fenceStart(line);
      if (fence) {
        let j = i + 1;
        const body: string[] = [];
        while (j < lines.length && !fenceEnd(lines[j], fence)) body.push(lines[j++]);
        const closed = j < lines.length;
        if (closed) j += 1;
        if (!this.reserve()) break;
        const code = body.join("\n");
        out.push({ type: "code", language: fence.language || null, text: closed ? code.replace(/\r$/, "") : code });
        i = j;
        continue;
      }

      if (isIndentedCode(line) && !(depth > 0 && listMarker(line))) {
        const body: string[] = [];
        let j = i;
        while (j < lines.length) {
          if (isIndentedCode(lines[j])) {
            body.push(stripIndent(contentLine(lines[j++])));
          } else if (!lines[j].trim()) {
            let next = j;
            while (next < lines.length && !lines[next].trim()) next += 1;
            if (next >= lines.length || !isIndentedCode(lines[next])) break;
            while (j < next) { body.push(""); j += 1; }
          } else break;
        }
        if (!this.reserve()) break;
        out.push({ type: "code", language: null, text: body.join("\n") });
        i = j;
        continue;
      }

      const heading = line.match(/^ {0,3}(#{1,})[ \t]+(.*)$/);
      if (heading) {
        if (!this.reserve()) break;
        const level = Math.min(heading[1].length, 4) as 1 | 2 | 3 | 4;
        out.push({ type: "heading", level, inlines: parseInline(stripHeadingClosingHashes(heading[2])) });
        i += 1;
        continue;
      }

      if (isRule(line)) {
        if (!this.reserve()) break;
        out.push({ type: "rule" });
        i += 1;
        continue;
      }

      const marker = listMarker(line);
      if (marker) {
        const parsed = this.list(lines, i, marker, depth);
        if (parsed.node) out.push(parsed.node);
        i = parsed.next;
        continue;
      }

      if (isQuote(line)) {
        const body: string[] = [];
        let j = i;
        while (j < lines.length && isQuote(lines[j])) body.push(stripQuote(lines[j++]));
        if (!this.reserve()) break;
        out.push({ type: "quote", children: this.blocks(body, depth + 1) });
        i = j;
        continue;
      }

      if (i + 1 < lines.length && isPipeRow(line) && isTableDivider(lines[i + 1])) {
        const rows: string[] = [tableRow(line)];
        let j = i + 2;
        while (j < lines.length && isPipeRow(lines[j]) && lines[j].trim()) rows.push(tableRow(lines[j++]));
        for (const row of rows) {
          if (!this.reserve()) break;
          out.push({ type: "paragraph", inlines: parseInline(row) });
        }
        i = j;
        continue;
      }

      const paragraph: string[] = [line.trim()];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !startsBlock(lines, j)) paragraph.push(lines[j++].trim());
      if (!this.reserve()) break;
      out.push({ type: "paragraph", inlines: parseInline(paragraph.join(" ")) });
      i = j;
    }
    return out;
  }

  private list(lines: string[], index: number, first: Marker, depth: number): { node?: RichNode; next: number } {
    if (!this.reserve()) return { next: index };
    const items: { inlines: Inline[]; children: RichNode[] }[] = [];
    let i = index;
    while (i < lines.length && !this.exhausted) {
      const marker = listMarker(contentLine(lines[i]));
      if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;
      if (!this.reserve()) break;
      const itemLines = [marker.text];
      i += 1;
      let activeFence = fenceStart(marker.text);
      while (i < lines.length) {
        const current = contentLine(lines[i]);
        const nextMarker = listMarker(current);
        const nestedLine = stripListIndent(lines[i], marker.width);
        if (activeFence) {
          itemLines.push(nestedLine);
          if (fenceEnd(nestedLine, activeFence)) activeFence = null;
          i += 1;
          continue;
        }
        const openingFence = leadingSpaces(current) >= marker.width ? fenceStart(nestedLine) : null;
        if (openingFence) {
          activeFence = openingFence;
          itemLines.push(nestedLine);
          i += 1;
          continue;
        }
        if (nextMarker && nextMarker.indent <= first.indent) break;
        if (!lines[i].trim()) {
          const afterLine = i + 1 < lines.length ? contentLine(lines[i + 1]) : "";
          const after = listMarker(afterLine);
          if ((after && after.indent >= marker.width) || (afterLine.trim() && leadingSpaces(afterLine) >= marker.width)) {
            itemLines.push("");
            i += 1;
            continue;
          }
          break;
        }
        const indent = leadingSpaces(current);
        if (indent <= first.indent && !nextMarker) break;
        itemLines.push(stripListIndent(lines[i], marker.width));
        i += 1;
      }
      const startsWithBlock = startsBlock(itemLines, 0);
      items.push({
        inlines: startsWithBlock ? [] : parseInline(marker.text),
        children: this.blocks(startsWithBlock ? itemLines : itemLines.slice(1), depth + 1),
      });
      if (i < lines.length && !lines[i].trim()) {
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        const nextMarker = next < lines.length ? listMarker(contentLine(lines[next])) : null;
        if (nextMarker && nextMarker.indent === first.indent && nextMarker.ordered === first.ordered) i = next;
        else break;
      }
    }
    const node: RichNode = first.ordered
      ? { type: "list", ordered: true, start: first.start, items }
      : { type: "list", ordered: false, items };
    return { node, next: i };
  }
}

const MAX_INLINE_DEPTH = 16;

function parseInline(source: string, inherited: { bold?: true; italic?: true } = {}, depth = 0): Inline[] {
  const result: Inline[] = [];
  if (depth >= MAX_INLINE_DEPTH) return source ? [{ type: "text", text: source, ...inherited }] : [];
  const nextTicks = nextTokenPositions(source, "`");
  const nextLinkOpens = nextTokenPositions(source, "](");
  const nextParens = nextTokenPositions(source, ")");
  const nextDoubleStars = nextTokenPositions(source, "**");
  const nextDoubleUnderscores = nextTokenPositions(source, "__");
  const nextStars = nextTokenPositions(source, "*");
  const nextUnderscores = nextTokenPositions(source, "_", (index) => !isWord(source[index - 1]) || !isWord(source[index + 1]));
  let plain = "";
  const flush = () => {
    if (plain) appendInline(result, { type: "text", text: plain, ...inherited });
    plain = "";
  };
  for (let i = 0; i < source.length;) {
    if (source[i] === "`") {
      const end = nextTicks[i + 1];
      if (end < source.length && end > i + 1) {
        flush(); appendInline(result, { type: "code", text: source.slice(i + 1, end) }); i = end + 1; continue;
      }
    }

    if (source[i] === "[") {
      const closeLabel = nextLinkOpens[i + 1];
      if (closeLabel < source.length) {
        const closeTarget = nextParens[closeLabel + 2];
        if (closeTarget >= source.length) { plain += source.slice(i); break; }
        const label = source.slice(i + 1, closeLabel);
        const url = source.slice(closeLabel + 2, closeTarget);
        if (label && !/[\s]/.test(url) && /^https:\/\//i.test(url)) {
          flush(); appendInline(result, { type: "link", text: label, url }); i = closeTarget + 1; continue;
        }
        const literal = source.slice(i, closeTarget + 1);
        plain += literal; i = closeTarget + 1; continue;
      }
    }

    if (source.slice(i, i + 8).toLowerCase() === "https://") {
      let end = i + 8;
      while (end < source.length && !/[\s<>]/.test(source[end])) end += 1;
      const url = trimSentencePunctuation(source.slice(i, end));
      if (url.length > "https://".length) {
        flush(); appendInline(result, { type: "link", text: url, url }); i += url.length; continue;
      }
    }

    const marker = source.startsWith("**", i) || source.startsWith("__", i)
      ? source.slice(i, i + 2)
      : source[i] === "*" || source[i] === "_" ? source[i] : "";
    const end = marker === "**" ? nextDoubleStars[i + 2]
      : marker === "__" ? nextDoubleUnderscores[i + 2]
        : marker === "*" ? nextStars[i + 1] : marker === "_" ? nextUnderscores[i + 1] : source.length;
    const validStart = marker !== "_" || !isWord(source[i - 1]) || !isWord(source[i + 1]);
    if (marker && validStart) {
      if (end < source.length && end > i + marker.length && source.slice(i + marker.length, end).trim()) {
        flush();
        const inner = source.slice(i + marker.length, end);
        const style = marker.length === 2 ? { bold: true as const } : { italic: true as const };
        const combined = { ...inherited, ...style };
        for (const child of parseInline(inner, combined, depth + 1)) appendInline(result, child);
        i = end + marker.length;
        continue;
      }
    }

    plain += source[i++];
  }
  flush();
  return result;
}

function nextTokenPositions(source: string, token: string, eligible: (index: number) => boolean = () => true): Int32Array {
  const next = new Int32Array(source.length + 1);
  next[source.length] = source.length;
  for (let i = source.length - 1; i >= 0; i -= 1) {
    next[i] = source.startsWith(token, i) && eligible(i) ? i : next[i + 1];
  }
  return next;
}

function trimSentencePunctuation(url: string): string {
  let end = url.length;
  while (end > 0 && ".,!?;:".includes(url[end - 1])) end -= 1;
  return url.slice(0, end);
}

function appendInline(target: Inline[], next: Inline): void {
  const previous = target[target.length - 1];
  if (previous?.type === "text" && next.type === "text" && previous.bold === next.bold && previous.italic === next.italic) {
    target[target.length - 1] = { ...previous, text: previous.text + next.text };
  } else target.push(next);
}

function isWord(character: string | undefined): boolean { return !!character && /[\p{L}\p{N}]/u.test(character); }
function leadingSpaces(line: string): number { return line.match(/^ */)?.[0].length ?? 0; }
function contentLine(line: string): string { return line.endsWith("\r") ? line.slice(0, -1) : line; }
function stripHeadingClosingHashes(text: string): string {
  const trimmed = text.replace(/[ \t]+$/, "");
  const closing = trimmed.match(/^(.*?)[ \t]+#+$/);
  return closing ? closing[1] : trimmed;
}
function isIndentedCode(line: string): boolean { return /^ {4}|^\t/.test(line); }
function stripIndent(line: string): string { return line.startsWith("\t") ? line.slice(1) : line.replace(/^ {4}/, ""); }
function isQuote(line: string): boolean { return /^ {0,3}>/.test(line); }
function stripQuote(line: string): string { return line.replace(/^ {0,3}> ?/, ""); }
function isRule(line: string): boolean { return /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line); }
function isPipeRow(line: string): boolean { return line.includes("|"); }
function tableRow(line: string): string {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()).join(" · ");
}
function isTableDivider(line: string): boolean {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{1,}:?\s*$/.test(cell));
}
function fenceStart(line: string): { char: string; size: number; language: string } | null {
  const match = contentLine(line).match(/^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/);
  return match ? { char: match[1][0], size: match[1].length, language: match[2].trim() } : null;
}
function fenceEnd(line: string, fence: { char: string; size: number }): boolean {
  const match = contentLine(line).match(/^ {0,3}(`+|~+)\s*$/);
  return !!match && match[1][0] === fence.char && match[1].length >= fence.size;
}
function listMarker(line: string): Marker | null {
  const match = line.match(/^( {0,})((?:[-+*])|(?:\d{1,9}[.)]))[ \t]+(.*)$/);
  if (!match) return null;
  const token = match[2];
  const ordered = /^\d/.test(token);
  return { indent: match[1].length, ordered, start: ordered ? Number.parseInt(token, 10) : 1, width: match[0].length - match[3].length, text: match[3] };
}
function stripListIndent(line: string, width: number): string {
  const content = contentLine(line);
  const indent = leadingSpaces(content);
  return indent >= width ? line.slice(width) : line;
}
function startsBlock(lines: string[], index: number): boolean {
  const line = contentLine(lines[index]);
  if (!line.trim()) return true;
  return !!fenceStart(line) || isIndentedCode(line) || isQuote(line) || isRule(line) || !!listMarker(line)
    || /^ {0,3}#{1,}[ \t]+/.test(line)
    || (index + 1 < lines.length && isPipeRow(line) && isTableDivider(lines[index + 1]));
}
