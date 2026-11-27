export type HaltState = { haltId: string; at: string; reason?: string; by: string };
export type ProjectHalt = HaltState & { projectId: string };
export type HaltView = {
  readable: boolean;
  host?: HaltState;
  projects: ProjectHalt[];
};

export type HaltPlace = "overview" | "screen" | { projectIds: readonly string[] };

export type HaltNotice =
  | { kind: "unreadable" }
  | { kind: "host"; halt: HaltState; projects: ProjectHalt[] }
  | { kind: "project"; halts: ProjectHalt[] }
  | { kind: "overview"; halts: ProjectHalt[] };

export function haltNotice(view: HaltView | null | undefined, place: HaltPlace): HaltNotice | null {
  if (!view) return null;
  if (!view.readable) return { kind: "unreadable" };
  const projects = view.projects ?? [];
  const own = typeof place === "object" ? projects.filter(halt => place.projectIds.includes(halt.projectId)) : projects;
  if (view.host) return { kind: "host", halt: view.host, projects: own };
  if (place === "screen") return null;
  if (place === "overview") return projects.length ? { kind: "overview", halts: projects } : null;
  return own.length ? { kind: "project", halts: own } : null;
}

export function workspaceHaltScope(
  repositories: readonly { id: string; name: string; checkoutIds: readonly string[] }[],
  checkouts: readonly { projectId: string; name: string }[] = [],
) {
  const names = new Map<string, string>();
  for (const repo of repositories) if (!names.has(repo.id)) names.set(repo.id, repo.name);
  for (const checkout of checkouts) names.set(checkout.projectId, checkout.name);
  const projectIds = [...new Set([...repositories.flatMap(repo => [repo.id, ...repo.checkoutIds]), ...checkouts.map(checkout => checkout.projectId)])];
  return { projectIds, name: (projectId: string) => names.get(projectId) };
}

export function createHaltStore() {
  let tickets = 0;
  const latest = new Map<string, { ticket: number; view: HaltView }>();
  const listeners = new Set<() => void>();
  return {
    begin: () => ++tickets,
    record(key: string, ticket: number, view: HaltView) {
      const current = latest.get(key);
      if (current && current.ticket > ticket) return;
      if (current && JSON.stringify(current.view) === JSON.stringify(view)) {
        latest.set(key, { ticket, view: current.view });
        return;
      }
      latest.set(key, { ticket, view });
      for (const listener of listeners) listener();
    },
    get: (key: string): HaltView | null => latest.get(key)?.view ?? null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const haltSince = (at: string) => new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
