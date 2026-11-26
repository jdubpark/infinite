export const MAX_TASK_LIMITATIONS = 20;
export const MAX_TASK_LIMITATION_CHARS = 1000;

const PLAIN_LIMITATIONS_RE = /^limitations\s*:(.*)$/i;
const BOLD_LIMITATIONS_RE = /^\*\*limitations:?\*\*\s*:?\s*(.*)$/i;
const ATX_LIMITATIONS_RE = /^#{1,6}\s+limitations\s*:?(?:\s+(.*))?$/i;
const ATX_HEADING_RE = /^#{1,6}\s+\S/;
const BOLD_HEADING_RE = /^\*\*[A-Za-z][A-Za-z0-9 /_-]{0,40}:?\*\*\s*:?(?:\s|$)/;
const BOLD_STANDALONE_RE = /^\*\*[^*]{1,60}\*\*\s*:?\s*$/;
const PLAIN_HEADING_RE = /^[A-Za-z][A-Za-z0-9 /_-]{0,40}:\s*$/;
const KNOWN_SECTION_RE = /^(?:summary|changes|verification|tests?|testing|checks?|next(?:\s+steps?)?|follow[- ]?ups?|risks?|evidence|results?|status|references?)\s*:/i;
const BULLET_RE = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/;
const EMPTY_BULLET_RE = /^(?:[-*+]\s*|\d+[.)]\s*)$/;

function boundLimitation(value: string): string {
  return value.length > MAX_TASK_LIMITATION_CHARS ? value.slice(0, MAX_TASK_LIMITATION_CHARS) : value;
}

export function normalizeTaskLimitations(limitations: readonly string[] | undefined): string[] {
  if (!limitations?.length) return [];
  const normalized: string[] = [];
  for (const item of limitations) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    normalized.push(boundLimitation(trimmed));
    if (normalized.length >= MAX_TASK_LIMITATIONS) break;
  }
  return normalized;
}

function matchLimitationsHeading(trimmed: string): { inline: string } | undefined {
  const plain = PLAIN_LIMITATIONS_RE.exec(trimmed);
  if (plain) return { inline: (plain[1] ?? "").trim() };
  const bold = BOLD_LIMITATIONS_RE.exec(trimmed);
  if (bold) return { inline: (bold[1] ?? "").trim() };
  const atx = ATX_LIMITATIONS_RE.exec(trimmed);
  if (atx) return { inline: (atx[1] ?? "").trim() };
  return undefined;
}

function isSectionHeading(trimmed: string): boolean {
  return ATX_HEADING_RE.test(trimmed)
    || BOLD_STANDALONE_RE.test(trimmed)
    || (BOLD_HEADING_RE.test(trimmed) && (trimmed.includes(":**") || /^\*\*[^*]+\*\*\s*:/.test(trimmed)))
    || PLAIN_HEADING_RE.test(trimmed)
    || KNOWN_SECTION_RE.test(trimmed);
}

export function extractTaskLimitations(summary: string | undefined): string[] {
  if (!summary) return [];
  const lines = summary.split(/\r?\n/);
  let start = -1;
  let heading: { inline: string } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const matched = matchLimitationsHeading(lines[index]!.trim());
    if (matched) {
      start = index;
      heading = matched;
      break;
    }
  }
  if (start < 0 || !heading) return [];

  const items: string[] = [];
  if (heading.inline) items.push(heading.inline);

  let index = start + 1;
  if (!heading.inline) {
    while (index < lines.length && lines[index]!.trim() === "") index += 1;
  }

  for (; index < lines.length; index++) {
    const trimmed = lines[index]!.trim();
    if (!trimmed || isSectionHeading(trimmed)) break;
    const bullet = BULLET_RE.exec(trimmed);
    if (bullet) {
      const text = bullet[1]!.trim();
      if (text) items.push(text);
    } else if (EMPTY_BULLET_RE.test(trimmed)) {
      continue;
    } else if (items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1]} ${trimmed}`;
    } else {
      items.push(trimmed);
    }
  }

  return normalizeTaskLimitations(items);
}

export function recordedTaskLimitations(report: { summary: string; limitations?: readonly string[] }): string[] {
  return report.limitations !== undefined
    ? normalizeTaskLimitations(report.limitations)
    : extractTaskLimitations(report.summary);
}

export function taskLimitations(task: { summary?: string; limitations?: readonly string[] }): string[] {
  return task.limitations !== undefined
    ? normalizeTaskLimitations(task.limitations)
    : extractTaskLimitations(task.summary);
}
