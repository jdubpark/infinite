/** Rows a client read from `GET /api/sessions`, and the version the host named for them, if it named one. */
type Held<T> = { sessions: T[]; version?: string };

/** The versions a client keeps and sends back: the alphabet and bound the host accepts in `since`. */
const VERSION = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * One answer to a session list read. Rows stand for themselves, with their version when the host names one (a host
 * that predates `since` ignores it and names none). `unchanged` stands for `held`, the rows held as the answer
 * arrives, when it names their version. Any other answer is unreadable.
 */
function readAnswer<T>(body: unknown, held?: Held<T>): Held<T> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const { sessions, version, unchanged } = body as { sessions?: unknown; version?: unknown; unchanged?: unknown };
  const named = typeof version === "string" && VERSION.test(version) ? version : undefined;
  if (Array.isArray(sessions)) return { sessions: sessions as T[], ...(named ? { version: named } : {}) };
  return unchanged === true && named !== undefined && named === held?.version ? held : undefined;
}

/**
 * Reads one host's session list, asking only for a change since the rows it read last: the host then answers
 * `{ version, unchanged: true }` in place of the rows. `get` sends a GET to the host's API path and resolves its JSON.
 * An unreadable answer is followed by a plain `GET /sessions`, the read every host answers; the reader then asks for
 * a version again on its next read. Reads may overlap: an answer that arrives after the answer to a later read is
 * older than the rows held, so it is not kept and that read resolves to the rows held, and `unchanged` stands only for
 * the version held when it arrives, which a read that answered meanwhile may have replaced. Use one reader per host.
 */
export function sessionListReader<T>(): (get: (path: string) => Promise<unknown>) => Promise<T[]> {
  let held: Held<T> | undefined, started = 0, kept = 0;
  return async get => {
    const read = ++started;
    const answer = await get(`/sessions?since=${held?.version ?? ""}`);
    const next = readAnswer<T>(answer, held) ?? readAnswer<T>(await get("/sessions"));
    if (!next) throw new Error("The machine sent a session list this app cannot read.");
    if (read < kept) return held!.sessions;
    held = next; kept = read;
    return next.sessions;
  };
}
