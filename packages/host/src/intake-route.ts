/** Route decision for an owner's request. Pure: it imports nothing from the host. */
export type IntakeRoute = { kind: "answer" | "work"; by: "owner" | "model" | "default"; confidence?: number };
export type RouteReading = { route: "answer" | "work"; confidence: number };

/** The most text of a mention that is sent to the reading service. */
export const ROUTE_INPUT_LIMIT = 1000;
/** A reading must reach this confidence to send a request to work. */
export const ROUTE_WORK_THRESHOLD = 0.6;

/** The owner's explicit word, and the text without it. Undefined when the text has no such word. */
export function explicitRoute(text: string): { route: "answer" | "work"; text: string } | undefined {
  const match = /^\s*(ask|work)\s*:\s*/i.exec(text);
  if (!match) return undefined;
  return { route: match[1]!.toLowerCase() === "ask" ? "answer" : "work", text: text.slice(match[0].length) };
}

/** The route from an explicit word, else a reading, else the default. */
export function decideRoute(explicit: { route: "answer" | "work" } | undefined, reading: RouteReading | undefined): IntakeRoute {
  if (explicit) return { kind: explicit.route, by: "owner" };
  if (reading) {
    const work = reading.route === "work" && reading.confidence >= ROUTE_WORK_THRESHOLD;
    return { kind: work ? "work" : "answer", by: "model", confidence: reading.confidence };
  }
  return { kind: "work", by: "default" };
}
