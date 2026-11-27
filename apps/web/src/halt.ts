export type HaltState = { haltId: string; at: string; reason?: string; by: string };
export type ProjectHalt = HaltState & { projectId: string };
export type HaltView = {
  readable: boolean;
  host?: HaltState;
  projects: ProjectHalt[];
};

export type HaltPlace = { projectIds: readonly string[] } | "overview";

export type HaltNotice =
  | { kind: "unreadable" }
  | { kind: "host"; halt: HaltState; projects: ProjectHalt[] }
  | { kind: "project"; halts: ProjectHalt[] }
  | { kind: "overview"; halts: ProjectHalt[] };

export function haltNotice(view: HaltView | null | undefined, place: HaltPlace): HaltNotice | null {
  if (!view) return null;
  if (!view.readable) return { kind: "unreadable" };
  const projects = view.projects ?? [];
  const own = place === "overview" ? projects : projects.filter(halt => place.projectIds.includes(halt.projectId));
  if (view.host) return { kind: "host", halt: view.host, projects: own };
  if (place === "overview") return projects.length ? { kind: "overview", halts: projects } : null;
  return own.length ? { kind: "project", halts: own } : null;
}

export function missionHaltPlace(repoProjectIds: readonly string[]): HaltPlace {
  return { projectIds: [...new Set(repoProjectIds)] };
}

export const haltSince = (at: string) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
