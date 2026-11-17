/** The owner's halt as `GET /api/halt` reports it. A halt is informational here: releasing it is a host CLI action. */
export type HaltState = { haltId: string; at: string; reason?: string; by: string };
export type ProjectHalt = HaltState & { projectId: string };
export type HaltView = {
  /** False when the host cannot read its halt record. The whole host is then halted until it can. */
  readable: boolean;
  host?: HaltState;
  projects: ProjectHalt[];
};

/** A screen that belongs to projects shows the halts that cover them; an overview lists every project halt compactly. */
export type HaltPlace = { projectIds: readonly string[] } | "overview";

export type HaltNotice =
  | { kind: "unreadable" }
  /** `projects` are the project halts that stay engaged when the host halt is released. */
  | { kind: "host"; halt: HaltState; projects: ProjectHalt[] }
  | { kind: "project"; halts: ProjectHalt[] }
  | { kind: "overview"; halts: ProjectHalt[] };

/** Which halt a screen shows. A host halt, readable or not, covers every screen and wins over project halts. */
export function haltNotice(view: HaltView | null | undefined, place: HaltPlace): HaltNotice | null {
  if (!view) return null;
  if (!view.readable) return { kind: "unreadable" };
  const projects = view.projects ?? [];
  const own = place === "overview" ? projects : projects.filter(halt => place.projectIds.includes(halt.projectId));
  if (view.host) return { kind: "host", halt: view.host, projects: own };
  if (place === "overview") return projects.length ? { kind: "overview", halts: projects } : null;
  return own.length ? { kind: "project", halts: own } : null;
}

/** The place of a mission page: the projects its subtasks run in. A mission with no subtasks yet covers none. */
export function missionHaltPlace(subtasks: readonly { repoProjectId: string }[]): HaltPlace {
  return { projectIds: [...new Set(subtasks.map(subtask => subtask.repoProjectId))] };
}

export const haltSince = (at: string) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
