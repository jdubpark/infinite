/** Rows a client read from `GET /api/sessions`, and the version the host named for them, if it named one. */
type Held<T> = { sessions: T[]; version?: string };

/** The versions a client keeps and sends back: the alphabet and bound the host accepts in `since`. */
const VERSION = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * One answer to a session list read. Rows stand for themselves, with their version when the host names one (a host
 * that predates `since` ignores it and names none). `unchanged` stands for `asked` when it names the version asked
 * with. Any other answer is unreadable.
 */
function readAnswer<T>(body: unknown, asked?: Held<T>): Held<T> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { sessions, version, unchanged } = body as { sessions?: unknown; version?: unknown; unchanged?: unknown };
  const named = typeof version === "string" && VERSION.test(version) ? version : undefined;
  if (Array.isArray(sessions)) return { sessions: sessions as T[], ...(named ? { version: named } : {}) };
  return unchanged === true && named !== undefined && named === asked?.version ? asked : undefined;
}

/**
 * Reads one host's session list, asking only for a change since the rows it read last: the host then answers
 * `{ version, unchanged: true }` in place of the rows. `get` sends a GET to the host's API path and resolves its JSON.
 * An unreadable answer is followed by a plain `GET /sessions`, the read every host answers; the reader then asks for
 * a version again on its next read. Use one reader per host.
 */
export function sessionListReader<T>(): (get: (path: string) => Promise<unknown>) => Promise<T[]> {
  let held: Held<T> | undefined;
  return async get => {
    const asked = held;
    const next = readAnswer<T>(await get(`/sessions?since=${asked?.version ?? ""}`), asked) ?? readAnswer<T>(await get("/sessions"));
    if (!next) throw new Error("The machine sent a session list this app cannot read.");
    held = next;
    return next.sessions;
  };
}
