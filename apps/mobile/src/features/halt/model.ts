/**
 * The owner's halt as `GET /api/halt` reports it, and which halt each screen shows. No React Native imports, so the
 * mapping can be tested under Node. A halt is informational here: releasing it is a host CLI action.
 */
export type HaltState = { haltId: string; at: string; reason?: string; by: string };
export type ProjectHalt = HaltState & { projectId: string };
export type HaltView = {
  /** False when the host cannot read its halt record. The whole host is then halted until it can. */
  readable: boolean;
  host?: HaltState;
  projects: ProjectHalt[];
};

/**
 * `overview`: the home screen, which also lists every project halt compactly. `screen`: another main screen, which
 * shows only a host halt. `projectIds`: a screen that belongs to those projects.
 */
export type HaltPlace = "overview" | "screen" | { projectIds: readonly string[] };

export type HaltNotice =
  | { kind: "unreadable" }
  /** `projects` are the project halts that stay engaged when the host halt is released. */
  | { kind: "host"; halt: HaltState; projects: ProjectHalt[] }
  | { kind: "project"; halts: ProjectHalt[] }
  | { kind: "overview"; halts: ProjectHalt[] };

/** A host halt, readable or not, covers every screen and wins over project halts. */
export function haltNotice(view: HaltView | null | undefined, place: HaltPlace): HaltNotice | null {
  if (!view) return null;
  if (!view.readable) return { kind: "unreadable" };
  const projects = view.projects ?? [];
  if (view.host) return { kind: "host", halt: view.host, projects };
  if (place === "screen") return null;
  if (place === "overview") return projects.length ? { kind: "overview", halts: projects } : null;
  const halts = projects.filter(halt => place.projectIds.includes(halt.projectId));
  return halts.length ? { kind: "project", halts } : null;
}

export const haltSince = (at: string) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
