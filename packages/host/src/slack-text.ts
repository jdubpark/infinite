const FENCE = /^```/;
const CLOSING_FENCE = /^```\s*$/;

/**
 * Splits text into parts of at most `limit` characters, breaking on line boundaries. A fenced block that must be cut
 * is closed at the end of one part and reopened with its opening line at the start of the next. A line longer than
 * the room left is cut at that room.
 */
export function splitSlackText(text: string, limit = 3000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let lines: string[] = [];
  let length = 0;
  // The opening line of the fence open at the current position, if any.
  let fence: string | undefined;
  // Lines a new part starts with before any content: the reopened fence line.
  let leading = 0;

  const flush = () => {
    if (fence !== undefined) lines.push("```");
    parts.push(lines.join("\n"));
    lines = fence !== undefined ? [fence] : [];
    leading = lines.length;
    length = lines.join("\n").length;
  };
  const nextFence = (current: string | undefined, line: string) => {
    if (current === undefined) return FENCE.test(line) ? line : undefined;
    return CLOSING_FENCE.test(line) ? undefined : current;
  };

  for (const line of text.split("\n")) {
    let rest = line;
    let fenceAfter = nextFence(fence, line);
    while (true) {
      // Room for the closing fence this line leaves open, or the one the part already needs.
      const reserve = fence !== undefined || fenceAfter !== undefined ? "\n```".length : 0;
      const separator = lines.length > 0 ? 1 : 0;
      const room = limit - length - separator - reserve;
      if (rest.length <= room) {
        lines.push(rest);
        length += separator + rest.length;
        break;
      }
      if (lines.length > leading) {
        flush();
        continue;
      }
      // Nothing but the reopened fence is in the part, so the line itself is cut.
      const cut = Math.max(1, room);
      lines.push(rest.slice(0, cut));
      length += separator + cut;
      rest = rest.slice(cut);
      flush();
      if (rest.length === 0) break;
    }
    fence = fenceAfter;
  }
  if (lines.length > leading || parts.length === 0) parts.push(lines.join("\n"));
  return parts;
}
