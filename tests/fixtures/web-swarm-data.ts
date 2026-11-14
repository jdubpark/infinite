// A synthetic host for the Swarm view: one mission with three subteams in two projects, two standalone
// teams, quiet runs, and two solo sessions. Every name, path, and ID here is a placeholder.
import type { CodeMap, SessionTouches, SwarmMember, SwarmMission, SwarmSession, SwarmTask, SwarmTeam, TeamStatus, TeamTouches } from "../../apps/web/src/swarm/types";

/** A tool name as a provider reports it: an MCP tool keeps its server and tool names, so it runs long. */
export const LONG_TOOL = "mcp__repository_documentation__search_architecture_and_implementation_references";

type AttentionState = "working" | "needs-you" | "turn-finished" | "idle" | "exited" | "unavailable" | "recording-error";
type MemberSpec = { role: string; status: string; attention?: AttentionState; profile?: "opus" | "sonnet" | "haiku" | "luna" | "flash"; tool?: string; task?: string; prompt?: "permission" | "question"; revision?: number; cost?: number };

const PROFILES = {
  opus: { id: "opus-xhigh", label: "Opus xhigh", provider: "claude" as const, model: "claude-opus", effort: "xhigh", tier: "strong" as const },
  sonnet: { id: "sonnet-high", label: "Sonnet high", provider: "claude" as const, model: "claude-sonnet", effort: "high", tier: "light" as const },
  haiku: { id: "haiku-high", label: "Haiku high", provider: "claude" as const, model: "claude-haiku", effort: "high", tier: "light" as const },
  luna: { id: "luna-high", label: "Luna high", provider: "codex" as const, model: "gpt-luna", effort: "high", tier: "light" as const },
  flash: { id: "flash-high", label: "Flash high", provider: "opencode" as const, model: "deepseek/flash", variant: "high", tier: "light" as const },
};
const usage = (cost: number) => ({ cost, tokens: { input: Math.round(cost * 90000), output: Math.round(cost * 9000), reasoning: 0, cacheRead: 0, cacheWrite: 0 }, messages: Math.round(cost * 40), pricing: { configured: 1, provider: 0, unknown: 0 } });

export type SwarmFixture = {
  now: number;
  sessions: SwarmSession[];
  teams: SwarmTeam[];
  missions: SwarmMission[];
  maps: Record<string, CodeMap>;
  touches: Record<string, TeamTouches>;
  sessionTouches: Record<string, SessionTouches>;
  projects: { id: string; name: string }[];
};

export function swarmFixture(now = Date.parse("2026-11-13T14:00:00.000Z")): SwarmFixture {
  let counter = 0;
  const id = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  const sessions: SwarmSession[] = [];
  const teams: SwarmTeam[] = [];
  const touches: Record<string, TeamTouches> = {};

  const session = (title: string, provider: string, projectId: string, state: AttentionState | undefined, extra: { tool?: string; prompt?: "permission" | "question"; status?: string; managed?: SwarmSession["managedBy"]; quiet?: number } = {}): SwarmSession => {
    const value: SwarmSession = {
      id: id(), title, provider, projectId, status: extra.status ?? (state === "exited" ? "exited" : "running"), createdAt: ago(5400), seq: 100, contextVersion: 0,
      ...(extra.managed ? { managedBy: extra.managed } : {}),
      ...(state ? { attention: {
        state, since: ago(extra.quiet ?? 40), source: "hook", now: "", lastActivityAt: ago(extra.quiet ?? 6), hooks: "active", hookErrors: 0, sawTurnEnd: false,
        ...(extra.tool ? { lastTool: { tool: extra.tool, summary: extra.tool, at: ago(4) } } : {}),
        ...(extra.prompt ? { prompt: { id: 77, kind: extra.prompt, title: "Permission needed", options: [], acceptsText: false, source: "hook", delegable: extra.prompt === "permission" } } : {}),
      } as SwarmSession["attention"] } : {}),
    };
    sessions.push(value);
    return value;
  };

  const team = (spec: { title: string; projectId: string; status: TeamStatus; members: MemberSpec[]; revision?: number; missionId?: string; created: number; updated?: number;
    checks?: ("passed" | "failed" | "running")[]; decisions?: number; review?: boolean; delegated?: boolean; tasks?: { id: string; paths: string[]; changed?: string[]; status?: SwarmTask["status"] }[]; files?: Record<string, [string, number, number][]> }): SwarmTeam => {
    const teamId = id(), revision = spec.revision ?? 1;
    const tasks: SwarmTask[] = (spec.tasks ?? []).map(task => ({ id: task.id, title: task.id, status: task.status ?? "running", dependsOn: [], paths: task.paths,
      ...(task.changed ? { changedPaths: { paths: task.changed, truncated: false }, commit: "c".repeat(40) } : {}) }));
    const permissionDecisions: NonNullable<SwarmTeam["permissionDecisions"]> = [];
    const members: SwarmMember[] = spec.members.map((member, index) => {
      const profile = PROFILES[member.profile ?? (member.role === "project-manager" || member.role === "reviewer" ? "opus" : "sonnet")];
      const live = ["running", "waiting"].includes(member.status);
      const attention = member.attention ?? (member.status === "running" ? "working" : live ? "idle" : undefined);
      const own = session(`${spec.title} ${member.role} ${index + 1}`, profile.provider, spec.projectId, live ? attention : "exited", { tool: member.tool, prompt: member.prompt, managed: spec.missionId ? { kind: "mission", missionId: spec.missionId, teamId } : undefined });
      const memberId = id();
      const task = member.task ? tasks.find(item => item.id === member.task) : undefined;
      if (task) task.memberId = memberId;
      if (member.prompt === "permission" && spec.delegated) permissionDecisions.push({ targetSessionId: own.id, promptId: 77, status: "reviewing" });
      return { memberId, sessionId: own.id, role: member.role, revision: member.revision ?? revision, title: `${member.role} ${index + 1}`, status: member.status, provider: profile.provider, modelProfile: profile,
        usage: usage(member.cost ?? 0.2 + index * 0.07), startedAt: ago(live ? Math.min(3000, spec.created) : spec.created), lastActivityAt: ago(live ? 8 : spec.updated ?? 8), ...(member.task ? { taskId: member.task } : {}) };
    });
    const value: SwarmTeam = {
      id: teamId, projectId: spec.projectId, provider: "claude", title: spec.title, status: spec.status, revision, // Like the host, every run carries a fresh updatedAt; `updated` is when its agents last acted.
      createdAt: ago(spec.created), updatedAt: ago(2),
      baseCommit: "a".repeat(40), headCommit: "b".repeat(40), ...(spec.missionId ? { missionId: spec.missionId } : {}), lineup: { coordinator: { tier: "strong" } }, members, tasks,
      checks: (spec.checks ?? []).map(status => ({ status, revision })),
      decisions: Array.from({ length: spec.decisions ?? 0 }, () => ({ id: id(), revision })),
      ...(spec.review ? { review: { revision } } : {}),
      ...(spec.delegated ? { permissions: { maxDecisions: 25 }, permissionDecisions } : {}),
      usage: { total: usage(members.reduce((sum, member) => sum + (member.usage?.cost ?? 0), 0)) },
      workers: { limit: 3, max: 4, running: members.filter(member => ["scout", "implementer"].includes(member.role) && member.status === "running").length, ready: 0 },
    };
    teams.push(value);
    touches[teamId] = { teamId, revision, members: members.map(member => {
      const files = spec.files?.[member.taskId ?? member.role] ?? [];
      return { memberId: member.memberId, sessionId: member.sessionId, observable: member.provider !== "opencode", complete: true, graphQueries: files.length ? 2 : 0, truncated: false,
        files: member.provider === "opencode" ? [] : files.map(([path, reads, edits]) => ({ path, reads, edits, lastAt: ago(30) })) };
    }) };
    return value;
  };

  const missionId = id();
  const coordinator = session("checkout-v2 coordinator", "claude", "shop-api", "working", { managed: { kind: "mission", missionId } });
  const api = team({ title: "api", projectId: "shop-api", status: "implementing", missionId, created: 4000, checks: [], delegated: true,
    tasks: [{ id: "orders-routes", paths: ["src/routes/orders"] }, { id: "cart-totals", paths: ["src/domain/cart"] }, { id: "tax-rules", paths: ["src/domain/tax"] }, { id: "schema", paths: ["db/migrations"], changed: ["db/migrations/0042_orders.sql"], status: "integrated" }],
    members: [{ role: "project-manager", status: "running" }, { role: "scout", status: "reported" }, { role: "scout", status: "reported" },
      { role: "implementer", status: "running", tool: "Edit", task: "orders-routes" }, { role: "implementer", status: "running", tool: "Bash", task: "cart-totals", profile: "luna" },
      { role: "implementer", status: "running", attention: "needs-you", prompt: "permission", task: "tax-rules", profile: "haiku" }, { role: "implementer", status: "reported", task: "schema" },
      { role: "permission-coordinator", status: "running", profile: "haiku" }],
    files: { "orders-routes": [["src/routes/orders/create.ts", 3, 2], ["src/routes/orders/index.ts", 2, 1], ["src/domain/cart/totals.ts", 4, 0], ["src/lib/http.ts", 2, 0]],
      "cart-totals": [["src/domain/cart/totals.ts", 5, 3], ["src/domain/cart/lines.ts", 2, 1], ["tests/cart.test.ts", 1, 2]],
      "tax-rules": [["src/domain/tax/rules.ts", 3, 1], ["src/domain/cart/totals.ts", 2, 0]], schema: [["db/migrations/0042_orders.sql", 1, 1]], "project-manager": [["src/routes/orders/index.ts", 2, 0], ["src/domain/cart/totals.ts", 1, 0]] } });
  const payments = team({ title: "payments", projectId: "shop-api", status: "verifying", missionId, created: 3900, checks: ["passed", "passed", "running"],
    tasks: [{ id: "provider-client", paths: ["src/payments"], changed: ["src/payments/client.ts", "src/payments/webhook.ts"], status: "integrated" }, { id: "refunds", paths: ["src/payments/refunds"], changed: ["src/payments/refunds/issue.ts"], status: "integrated" }],
    members: [{ role: "project-manager", status: "waiting" }, { role: "implementer", status: "reported", task: "provider-client" }, { role: "implementer", status: "reported", task: "refunds", profile: "luna" }, { role: "integrator", status: "running", tool: "Bash" }],
    files: { "provider-client": [["src/payments/client.ts", 4, 3], ["src/payments/webhook.ts", 2, 2], ["src/lib/http.ts", 3, 0]], refunds: [["src/payments/refunds/issue.ts", 2, 2], ["src/payments/client.ts", 3, 0]], integrator: [["src/payments/client.ts", 1, 1], ["tests/payments.test.ts", 2, 1]] } });
  const web = team({ title: "web", projectId: "shop-web", status: "reviewing", missionId, created: 3800, checks: ["passed", "passed"], review: false,
    tasks: [{ id: "checkout-page", paths: ["app/checkout"], changed: ["app/checkout/page.tsx", "app/checkout/summary.tsx"], status: "integrated" }, { id: "cart-drawer", paths: ["components/cart"], changed: ["components/cart/drawer.tsx"], status: "integrated" }],
    members: [{ role: "project-manager", status: "waiting" }, { role: "scout", status: "reported" }, { role: "implementer", status: "reported", task: "checkout-page" }, { role: "implementer", status: "reported", task: "cart-drawer", profile: "flash" },
      { role: "integrator", status: "reported" }, { role: "reviewer", status: "running", tool: "Bash" }],
    files: { "checkout-page": [["app/checkout/page.tsx", 3, 4], ["app/checkout/summary.tsx", 2, 2], ["lib/api/orders.ts", 3, 1]], reviewer: [["app/checkout/page.tsx", 2, 0], ["components/cart/drawer.tsx", 2, 0], ["lib/api/orders.ts", 1, 0]] } });
  const missions: SwarmMission[] = [{
    id: missionId, title: "checkout-v2", status: "working", createdAt: ago(4200), updatedAt: ago(5), coordinator: { memberId: id(), sessionId: coordinator.id, status: "running" },
    subtasks: [{ id: "api", repoProjectId: "shop-api", title: "api", dependsOn: [], status: "running", teamId: api.id }, { id: "payments", repoProjectId: "shop-api", title: "payments", dependsOn: [], status: "running", teamId: payments.id },
      { id: "web", repoProjectId: "shop-web", title: "web", dependsOn: ["api"], status: "running", teamId: web.id }, { id: "emails", repoProjectId: "shop-api", title: "emails", dependsOn: ["api", "payments"], status: "queued" }],
    decisions: [], lineup: { coordinator: PROFILES.opus }, usage: { total: usage(6.4) },
  }];

  team({ title: "fix-login", projectId: "shop-web", status: "needs-input", created: 2400, decisions: 1,
    tasks: [{ id: "session-cookie", paths: ["lib/auth"] }], members: [{ role: "project-manager", status: "waiting" }, { role: "scout", status: "reported" }, { role: "implementer", status: "waiting", task: "session-cookie" }],
    files: { "session-cookie": [["lib/auth/session.ts", 4, 1], ["app/login/page.tsx", 2, 0]] } });
  team({ title: "search-index", projectId: "shop-api", status: "implementing", created: 1800, delegated: true,
    tasks: [{ id: "indexer", paths: ["src/search/indexer"] }, { id: "query-api", paths: ["src/routes/search"] }, { id: "ranking", paths: ["src/search/ranking"] }, { id: "backfill", paths: ["scripts"] }],
    members: [{ role: "project-manager", status: "running" }, { role: "implementer", status: "running", tool: "Edit", task: "indexer", profile: "luna" }, { role: "implementer", status: "running", attention: "needs-you", prompt: "question", task: "query-api" },
      { role: "implementer", status: "unavailable", task: "ranking", profile: "flash" }, { role: "implementer", status: "queued", task: "backfill", profile: "haiku" }],
    files: { indexer: [["src/search/indexer/build.ts", 4, 3], ["src/search/indexer/tokens.ts", 2, 1], ["src/lib/http.ts", 1, 0]], "query-api": [["src/routes/search/index.ts", 3, 2], ["src/search/indexer/build.ts", 2, 0]] } });
  team({ title: "rate-limits", projectId: "shop-api", status: "merged", created: 30000, updated: 18000, members: [{ role: "project-manager", status: "stopped" }, { role: "implementer", status: "stopped" }] });
  team({ title: "docs-refresh", projectId: "shop-web", status: "cancelled", created: 120000, updated: 108000, members: [{ role: "project-manager", status: "stopped" }] });
  team({ title: "legacy-cleanup", projectId: "shop-web", status: "blocked", created: 400000, updated: 300000, members: [{ role: "project-manager", status: "stopped" }] });

  const soloA = session("explore flaky test", "claude", "shop-api", "working", { tool: "Bash" });
  const soloB = session("review notes", "codex", "shop-web", "turn-finished", { quiet: 600 });
  const sessionTouches: Record<string, SessionTouches> = {
    [soloA.id]: { sessionId: soloA.id, observable: true, complete: true, graphQueries: 1, truncated: false, files: [{ path: "tests/cart.test.ts", reads: 3, edits: 0, lastAt: ago(20) }, { path: "src/domain/cart/totals.ts", reads: 2, edits: 0, lastAt: ago(60) }] },
    [soloB.id]: { sessionId: soloB.id, observable: true, complete: true, graphQueries: 0, truncated: false, files: [{ path: "app/checkout/page.tsx", reads: 2, edits: 0, lastAt: ago(700) }] },
    [coordinator.id]: { sessionId: coordinator.id, observable: true, complete: true, graphQueries: 0, truncated: false, files: [] },
  };

  const map = (areas: [string, number, number][], links: [string, string, number][]): CodeMap => ({ state: "ready", lane: "shared", head: "a".repeat(40), builtAt: ago(900),
    areas: areas.map(([area, files, symbols]) => ({ id: area, files, symbols })), links: links.map(([source, target, weight]) => ({ source, target, weight })), truncated: { areas: false, links: false } });
  const maps: Record<string, CodeMap> = {
    "shop-api": map([["src/routes/orders", 6, 48], ["src/routes/search", 3, 21], ["src/routes/users", 5, 39], ["src/domain/cart", 7, 88], ["src/domain/tax", 4, 31], ["src/domain/inventory", 6, 54], ["src/payments", 8, 96], ["src/payments/refunds", 3, 22],
      ["src/search/indexer", 5, 61], ["src/search/ranking", 4, 37], ["src/lib", 9, 120], ["db/migrations", 42, 42], ["tests", 31, 210], ["scripts", 6, 18]],
    [["src/domain/cart", "src/routes/orders", 22], ["src/domain/cart", "src/domain/tax", 14], ["src/domain/cart", "src/domain/inventory", 9], ["src/lib", "src/routes/orders", 17], ["src/lib", "src/payments", 25], ["src/payments", "src/payments/refunds", 12],
      ["src/payments", "src/routes/orders", 8], ["src/routes/search", "src/search/indexer", 11], ["src/search/indexer", "src/search/ranking", 15], ["src/lib", "src/search/indexer", 6], ["src/domain/cart", "tests", 19], ["src/payments", "tests", 13],
      ["src/lib", "src/routes/users", 10], ["db/migrations", "src/domain/inventory", 4], ["scripts", "src/search/indexer", 3]]),
    "shop-web": map([["app/checkout", 6, 52], ["app/login", 3, 19], ["app/account", 5, 33], ["components/cart", 7, 64], ["components/ui", 22, 140], ["lib/api", 6, 45], ["lib/auth", 4, 28], ["lib/format", 3, 15], ["tests", 18, 96]],
    [["app/checkout", "components/cart", 16], ["app/checkout", "lib/api", 12], ["components/cart", "components/ui", 21], ["app/login", "lib/auth", 9], ["lib/api", "lib/auth", 7], ["app/account", "lib/api", 8], ["app/checkout", "components/ui", 18],
      ["components/cart", "lib/format", 5], ["app/checkout", "tests", 6]]),
  };
  return { now, sessions, teams, missions, maps, touches, sessionTouches, projects: [{ id: "shop-api", name: "shop-api" }, { id: "shop-web", name: "shop-web" }] };
}
