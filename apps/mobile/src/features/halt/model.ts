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
  /** `projects` are the project halts that stay engaged when the host halt is released; a project screen lists only its own. */
  | { kind: "host"; halt: HaltState; projects: ProjectHalt[] }
  | { kind: "project"; halts: ProjectHalt[] }
  | { kind: "overview"; halts: ProjectHalt[] };

/** A host halt, readable or not, covers every screen and wins over project halts. */
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

/**
 * The projects a workspace covers, read from its repositories: each repository's checkouts and its primary project
 * (`id`). The cached offline summary keeps these IDs, so the halt scope does not depend on a live group read.
 * `checkouts` from a live group read add names; a repository's name applies only to its primary project.
 */
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

/**
 * One halt snapshot per machine, shared by every screen. A read takes a ticket before it starts, and only a read that
 * started after the stored one may replace it, so a late answer to an earlier read, or a screen's own retained copy,
 * never brings back a halt the owner has released. A failed read leaves the snapshot as it was.
 */
export function createHaltStore() {
  let tickets = 0;
  const latest = new Map<string, { ticket: number; view: HaltView }>();
  const listeners = new Set<() => void>();
  return {
    begin: () => ++tickets,
    record(key: string, ticket: number, view: HaltView) {
      const current = latest.get(key);
      if (current && current.ticket > ticket) return;
      // Keep the stored object when nothing changed, so subscribed screens do not redraw on every poll.
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
