import { readFileSync } from "node:fs";
import type { KnowledgeCatalog, KnowledgeClaim, KnowledgeComponent, KnowledgeMaintenance, KnowledgeRelationship, WorkspaceKnowledge } from "@infinite/remote";
import type { ProjectGroupList } from "./project-group-types.js";
import type { WorkspaceUnderstanding, UnderstandingArtifact, UnderstandingWork } from "@infinite/remote";

type Options = Record<string, string | boolean>;
type Api = { json<T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type IndexResponse = { components: Pick<KnowledgeComponent, "id" | "name" | "description" | "repositoryIds" | "pinned" | "retired" | "redirectTo">[]; coverage: string[] };
type DetailResponse = { component: KnowledgeComponent; relationships: KnowledgeRelationship[]; coverage: string[] };
const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
const short = (value: unknown, limit = 220) => { const text = clean(value); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const listed = (values: string[]) => values.length ? values.map(clean).join(", ") : "none";
const validId = /^[A-Za-z0-9_-]{1,160}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function artifactLines(artifact: UnderstandingArtifact): string[] {
  const lines = [`    Brief ${artifact.id} · ${artifact.sourceKind} ${artifact.sourceProjectId} · session ${artifact.sessionId}`,
    `      generated ${artifact.generatedAt} · retained ${artifact.retainedAt} · head ${artifact.head ?? "unborn"} · base ${artifact.base ?? "unborn"}`,
    `      ${artifact.brief.summary}`];
  for (const claim of artifact.brief.architecture) lines.push(`      Current: ${claim.text}${claim.citations.length ? ` [${claim.citations.map(c => `${c.source}:${c.line}`).join(", ")}]` : ""}`);
  for (const claim of artifact.brief.changes) lines.push(`      Change: ${claim.text}${claim.citations.length ? ` [${claim.citations.map(c => `${c.source}:${c.line}`).join(", ")}]` : ""}`);
  for (const claim of artifact.brief.checks) lines.push(`      Check: ${claim.text}${claim.citations.length ? ` [${claim.citations.map(c => `${c.source}:${c.line}`).join(", ")}]` : ""}`);
  for (const review of artifact.brief.review) lines.push(`      Review (${review.priority}): ${review.area} — ${review.why} Ask: ${review.question}`);
  for (const guidance of artifact.brief.guidance) lines.push(`      Guidance (${guidance.basis}): ${guidance.text}`);
  for (const unknown of artifact.brief.unknowns) lines.push(`      Unknown: ${unknown}`);
  for (const evidence of artifact.evidence) lines.push(`      Evidence ${evidence.source}:${evidence.line}: ${evidence.text}`);
  for (const coverage of artifact.coverage) lines.push(`      Coverage: ${coverage}`);
  return lines;
}

function workLines(work: UnderstandingWork): string[] {
  const rows = [`  ${work.kind} ${work.id} · ${work.column}/${work.status} · ${work.title}${work.scope === "partial" ? " · partial cross-workspace association" : ""}`];
  if (work.objective) rows.push(`    Objective: ${work.objective}`);
  if (work.reportedSummary) rows.push(`    Reported: ${work.reportedSummary}`);
  if (work.repositoryIds.length) rows.push(`    Repositories: ${listed(work.repositoryIds)}`);
  if (work.links.length) rows.push(`    Links: ${work.links.map(link => `${link.kind} ${link.label} ${link.url}`).join(" · ")}`);
  return rows;
}

export function renderUnderstanding(value: WorkspaceUnderstanding): string[] {
  if (value.schemaVersion !== 1) throw new Error("This host returned an unsupported Understanding response");
  if (!value.workspace?.id || !value.work || !value.repositories) throw new Error("This host returned a mismatched Understanding response");
  const lines = [`Understanding · ${value.workspace.name} (${value.workspace.id}) · revision ${value.workspace.revision} · observed ${value.observedAt}`, "Work"];
  if (!value.work.length) lines.push("  No linked work was found.");
  for (const work of value.work) lines.push(...workLines(work));
  lines.push("System");
  if (!value.repositories.length) lines.push("  No enrolled repositories were returned.");
  for (const repo of value.repositories) {
    lines.push(`  ${repo.name} (${repo.id}) · ${repo.state} · checkouts ${listed(repo.checkoutIds)}`);
    for (const artifact of repo.current) lines.push(...artifactLines(artifact));
    for (const plan of repo.planned) lines.push(`    Planned: ${plan.title} · ${plan.status} · ${plan.text}`);
    for (const warning of repo.warnings) lines.push(`    Warning: ${warning}`);
    for (const coverage of repo.coverage) lines.push(`    Coverage: ${coverage}`);
  }
  for (const coverage of value.coverage) lines.push(`Coverage: ${coverage}`);
  if (value.knowledge) lines.push(...renderKnowledgeIndex(value.knowledge));
  return lines.map(line => clean(line));
}

function claimText(claim: KnowledgeClaim): string {
  const citations = claim.evidence.map(item => `${item.repositoryId}:${item.source}${item.line === null ? "" : `:${item.line}`}`).join(", ");
  return `${short(claim.text)} · ${claim.basis}${citations ? ` [${citations}]` : ""}`;
}
function renderKnowledgeIndex(knowledge: WorkspaceKnowledge): string[] {
  const { catalog } = knowledge;
  const lines = ["Owner catalog"];
  for (const project of catalog.projects.filter(item => !item.archived)) lines.push(`  Project ${project.id} · r${project.revision} · ${project.name} · repositories ${listed(project.repositoryIds)}${project.description ? ` · ${short(project.description)}` : ""}`);
  for (const feature of catalog.features.filter(item => !item.archived)) lines.push(`  Feature ${feature.id} · ${feature.status} · ${feature.title} · work ${listed(feature.workIds)} · components ${listed(feature.componentIds)}`);
  for (const component of knowledge.components) {
    lines.push(`  Component ${component.id} · ${component.name} · ${component.current.state} · ${component.difference.state}`);
    if (component.current.summary) lines.push(`    Current: ${short(component.current.summary)}`);
    for (const claim of component.current.claims.slice(0, 2)) lines.push(`    Current claim: ${claimText(claim)}`);
    for (const plan of component.planned.slice(0, 3)) lines.push(`    Planned: ${plan.status} · ${plan.title} · ${short(plan.text)}`);
    if (component.difference.summary) lines.push(`    Difference: ${short(component.difference.summary)}`);
  }
  for (const delivery of knowledge.delivery) {
    lines.push(`  Delivery ${delivery.repositoryId} · ${delivery.state}`);
    for (const pr of delivery.pullRequests.slice(0, 3)) lines.push(`    Pull request: #${pr.number} ${pr.state} · ${pr.title} · checks ${pr.checks.map(check => `${check.name}=${check.conclusion ?? check.status}`).join(", ") || "none"}`);
    for (const env of delivery.environments.slice(0, 3)) lines.push(`    Environment: ${env.environment} · ${env.status} · ${env.revision}`);
  }
  lines.push(`  Maintenance: ${knowledge.maintenance.state} · ${knowledge.maintenance.message ?? "no message"}`);
  lines.push(`  Policy: enabled=${catalog.policy.enabled} synthesis=${catalog.policy.synthesis} delivery=${catalog.policy.delivery} interval=${catalog.policy.intervalMinutes}m daily-limit=${catalog.policy.dailyJobLimit}`);
  for (const coverage of knowledge.coverage) lines.push(`  Coverage: ${coverage}`);
  return lines;
}

function renderCatalog(value: KnowledgeCatalog): string[] {
  const lines = [`Catalog · revision ${value.revision}`, `Policy · enabled=${value.policy.enabled} synthesis=${value.policy.synthesis} delivery=${value.policy.delivery} interval=${value.policy.intervalMinutes}m daily-limit=${value.policy.dailyJobLimit}`];
  for (const row of value.projects) lines.push(`Project ${row.id} · r${row.revision} · ${row.archived ? "archived" : "active"} · ${row.name} · repositories ${listed(row.repositoryIds)}`);
  for (const row of value.features) lines.push(`Feature ${row.id} · ${row.archived ? "archived" : row.status} · ${row.title} · project ${row.projectId ?? "none"} · work ${listed(row.workIds)} · components ${listed(row.componentIds)}`);
  for (const row of value.plans) lines.push(`Plan ${row.id} · ${row.archived ? "archived" : row.status} · ${row.title} · component ${row.componentId} · repositories ${listed(row.repositoryIds)} · work ${row.workId ?? "none"}`);
  for (const row of value.componentOverrides) lines.push(`Component override ${row.id} · ${row.pinned ? "pinned" : "un-pinned"} · ${row.name} · repositories ${listed(row.repositoryIds)}${row.redirectTo ? ` · redirects to ${row.redirectTo}` : ""}`);
  for (const coverage of value.coverage) lines.push(`Coverage: ${coverage}`);
  return lines.map(clean);
}
function renderComponents(value: IndexResponse): string[] {
  const lines = ["Components"];
  for (const c of value.components) lines.push(`${c.id} · ${c.name} · repositories ${listed(c.repositoryIds)}${c.pinned ? " · pinned" : ""}${c.retired ? " · retired" : ""}${c.redirectTo ? ` · redirects to ${c.redirectTo}` : ""} · ${short(c.description, 120)}`);
  if (!value.components.length) lines.push("No components were returned.");
  for (const coverage of value.coverage) lines.push(`Coverage: ${coverage}`);
  return lines.map(clean);
}
function renderComponent(value: DetailResponse): string[] {
  const c = value.component;
  const lines = [`${c.name} (${c.id}) · ${c.current.state} · ${c.difference.state}`, `Repositories: ${listed(c.repositoryIds)}`, `Description: ${c.description}`, `Current: ${c.current.summary || "unavailable"}`];
  for (const source of c.current.sources) lines.push(`Source: ${source.repositoryId} · head ${source.head ?? "unborn"} · fingerprint ${source.fingerprint} · observed ${source.observedAt}`);
  lines.push(`Generated: ${c.current.generatedAt ?? "not synthesized"} · snapshot ${c.current.snapshotId}`);
  for (const claim of c.current.claims) lines.push(`Claim: ${claimText(claim)}`);
  for (const plan of c.planned) lines.push(`Plan: ${plan.status} · ${plan.title} · ${plan.text}`);
  lines.push(`Difference: ${c.difference.summary}`);
  for (const claim of c.difference.claims) lines.push(`Difference claim: ${claimText(claim)}`);
  for (const entry of c.history) lines.push(`History: ${entry.at} · ${entry.snapshotId} · ${entry.summary}`);
  for (const relationship of value.relationships) lines.push(`Relationship: ${relationship.from} ${relationship.kind} ${relationship.to} · ${relationship.basis} · ${relationship.summary}`);
  for (const coverage of [...c.coverage, ...value.coverage]) lines.push(`Coverage: ${coverage}`);
  return lines.map(clean);
}
function renderMaintenance(value: KnowledgeMaintenance): string[] { return [`Maintenance · ${value.state} · jobs today ${value.jobsToday}/${value.dailyJobLimit}`, `Observed ${value.lastObservedAt ?? "never"} · published ${value.lastPublishedAt ?? "never"} · next ${value.nextAttemptAt ?? "not scheduled"}`, value.message ? `Message: ${value.message}` : ""].filter(Boolean).map(clean); }

function requireOptions(options: Options, allowed: string[]) {
  const unexpected = Object.keys(options).filter(key => key !== "--client-config" && !allowed.includes(key));
  if (unexpected.length) throw new Error(`Option ${unexpected[0]} does not apply to this understand command`);
}
function readValue(file: string): unknown {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch (error) { throw new Error(`Cannot read JSON value from --file: ${clean((error as Error).message)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("--file must contain a JSON object value");
  return value;
}
function revisionOption(options: Options): number {
  const raw = options["--revision"];
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("Mutations require --revision with a nonnegative integer catalog revision");
  return Number(raw);
}
function requestIdOption(options: Options): string {
  const id = options["--request-id"];
  if (typeof id !== "string" || !uuid.test(id)) throw new Error("Mutations require --request-id with a UUID; reuse it only when retrying the same request");
  return id;
}
function workspaceId(options: Options): string {
  const id = options["--workspace"];
  if (typeof id !== "string" || !id.trim()) throw new Error("This understand command requires an ID with --workspace");
  if (!validId.test(id)) throw new Error("Invalid workspace ID");
  return id;
}
function printJsonOrLines(value: unknown, lines: string[], json: boolean) {
  if (json) console.log(JSON.stringify(value, null, 2)); else for (const line of lines) console.log(clean(line));
}
const route = (workspace: string, suffix: string) => `/project-groups/${encodeURIComponent(workspace)}/understanding${suffix}`;

export async function handleUnderstandingCommand(positional: string[], options: Options, api: Api): Promise<boolean> {
  if (positional.length > 3) throw new Error("Unexpected extra understand arguments; no request was sent.");
  const [command, arg, extra] = positional;
  const workspace = options["--workspace"] === true ? "" : String(options["--workspace"] ?? "");
  if (!command) {
    requireOptions(options, ["--workspace", "--json"]);
    if (options["--workspace"] === true) throw new Error("Workspace Understanding requires an ID with --workspace");
    if (!workspace) {
      const groups = await api.json<ProjectGroupList>("/project-groups");
      const visible = groups.groups.filter(group => !group.hidden);
      if (options["--json"]) console.log(JSON.stringify({ workspaces: visible.map(group => ({ id: group.id, name: group.name, repositoryCount: group.repos.length })) }, null, 2));
      else for (const group of visible) console.log(`${group.id}  ${clean(group.name)}  · ${group.repos.length} repositories`);
      return true;
    }
    const id = workspaceId(options);
    try {
      const value = await api.json<WorkspaceUnderstanding>(route(id, ""));
      if (value.workspace?.id !== id) throw new Error("This host returned a mismatched Understanding response");
      printJsonOrLines(value, renderUnderstanding(value), Boolean(options["--json"]));
    } catch (error) {
      if ((error as { status?: number }).status === 404) throw new Error("Workspace Understanding requires a newer host or a valid workspace ID.");
      throw error;
    }
    return true;
  }
  const id = workspaceId(options);
  if (["catalog", "components", "component", "refresh", "policy"].includes(command)) {
    if (command === "component" && (!arg || extra || !validId.test(arg))) throw new Error("Usage: infinite understand component COMPONENT_ID --workspace ID [--json]");
    if (command !== "component" && (arg || extra)) throw new Error(`Usage: infinite understand ${command} --workspace ID [--json]`);
    if (command === "refresh") {
      requireOptions(options, ["--workspace", "--json"]);
      const value = await api.json<KnowledgeMaintenance>(route(id, "/refresh"), {}, undefined, undefined, "POST");
      printJsonOrLines(value, renderMaintenance(value), Boolean(options["--json"]));
      return true;
    }
    if (command === "policy" && options["--file"] !== undefined) {
      requireOptions(options, ["--workspace", "--file", "--revision", "--request-id", "--json"]);
      if (typeof options["--file"] !== "string") throw new Error("Policy update requires --file with a JSON object value");
      const envelope = { requestId: requestIdOption(options), revision: revisionOption(options), action: "update", value: readValue(options["--file"] as string) };
      const value = await api.json<KnowledgeCatalog>(route(id, "/catalog/policy"), envelope, undefined, undefined, "POST");
      printJsonOrLines(value, renderCatalog(value), Boolean(options["--json"]));
      return true;
    }
    requireOptions(options, ["--workspace", "--json"]);
    if (command === "catalog") { const value = await api.json<KnowledgeCatalog>(route(id, "/catalog")); printJsonOrLines(value, renderCatalog(value), Boolean(options["--json"])); }
    if (command === "components") { const value = await api.json<IndexResponse>(route(id, "/components")); printJsonOrLines(value, renderComponents(value), Boolean(options["--json"])); }
    if (command === "component") { const value = await api.json<DetailResponse>(route(id, `/components/${encodeURIComponent(arg!)}`)); printJsonOrLines(value, renderComponent(value), Boolean(options["--json"])); }
    if (command === "policy") { const value = await api.json<KnowledgeCatalog>(route(id, "/catalog")); if (options["--json"]) console.log(JSON.stringify(value.policy, null, 2)); else console.log(`Policy · enabled=${value.policy.enabled} synthesis=${value.policy.synthesis} delivery=${value.policy.delivery} interval=${value.policy.intervalMinutes}m daily-limit=${value.policy.dailyJobLimit}`); }
    return true;
  }
  if (["create", "update", "archive"].includes(command)) {
    const collection = arg;
    const entityId = extra;
    if (!collection || !["projects", "features", "plans", "components", "policy"].includes(collection)) throw new Error("Usage: infinite understand create|update|archive projects|features|plans|components|policy [ENTITY_ID] --workspace ID --revision N --request-id UUID [--file JSON]");
    const policy = collection === "policy";
    if ((command === "create" && ["components", "policy"].includes(collection)) || (command === "archive" && ["components", "policy"].includes(collection))) throw new Error("Components use update to create or change an owner override; policy uses the policy command");
    if ((command === "create" && (entityId || policy)) || (command === "update" && (policy ? Boolean(entityId) : !entityId)) || (command === "archive" && (policy || !entityId))) throw new Error("Invalid collection or entity ID for this catalog action");
    if (entityId && !validId.test(entityId)) throw new Error("Invalid entity ID");
    requireOptions(options, ["--workspace", "--revision", "--request-id", "--file", "--json"]);
    const requestId = requestIdOption(options), revision = revisionOption(options);
    const file = options["--file"];
    if (command === "archive" && file !== undefined) throw new Error("Archive does not accept --file");
    if (command !== "archive" && typeof file !== "string") throw new Error("Create and update require --file with a JSON object value");
    const envelope: Record<string, unknown> = { requestId, revision, action: command };
    if (command !== "archive") envelope.value = readValue(file as string);
    const suffix = `/catalog/${collection}${entityId ? `/${encodeURIComponent(entityId)}` : ""}`;
    const value = await api.json<KnowledgeCatalog>(route(id, suffix), envelope, undefined, undefined, "POST");
    printJsonOrLines(value, renderCatalog(value), Boolean(options["--json"]));
    return true;
  }
  throw new Error(`Unknown understand command: ${clean(command)}`);
}
