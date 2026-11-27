export type IntakeRoute = { kind: "answer" | "work"; by: "owner" | "model" | "default"; confidence?: number };
export type RouteReading = { route: "answer" | "work"; confidence: number };

export const ROUTE_INPUT_LIMIT = 1000;
export const ROUTE_WORK_THRESHOLD = 0.6;

export function explicitRoute(text: string): { route: "answer" | "work"; text: string } | undefined {
  const match = /^\s*(ask|work)\s*:\s*/i.exec(text);
  if (!match) return undefined;
  return { route: match[1]!.toLowerCase() === "ask" ? "answer" : "work", text: text.slice(match[0].length) };
}

export function decideRoute(explicit: { route: "answer" | "work" } | undefined, reading: RouteReading | undefined): IntakeRoute {
  if (explicit) return { kind: explicit.route, by: "owner" };
  if (reading) {
    const work = reading.route === "work" && reading.confidence >= ROUTE_WORK_THRESHOLD;
    return { kind: work ? "work" : "answer", by: "model", confidence: reading.confidence };
  }
  return { kind: "work", by: "default" };
}
