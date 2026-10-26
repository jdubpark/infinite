const MAX_REASON = 400;

/** One-line, bounded reason for a failure: no long tokens, no long absolute paths. */
export function failureReason(error: unknown, stderr?: string): string {
  const base = error instanceof Error ? error.message : String(error);
  const last = (stderr ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
  return `${base}${last ? ` · ${last}` : ""}`
    .replace(/\s+/g, " ")
    .replace(/(?:\/[^\s/]+)+/g, path => path.length > 80 ? path.split("/").slice(-2).join("/") : path)
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .trim().slice(0, MAX_REASON);
}
