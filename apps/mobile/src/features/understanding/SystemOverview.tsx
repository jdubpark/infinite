import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { api, type Connection } from "../../api/client";
import type { DiagramGraph, KnowledgeRepositoryBrief, UnderstandingArtifact, UnderstandingCitation, UnderstandingPlan, UnderstandingRepository, WorkspaceUnderstanding } from "@infinite/remote";
import { theme } from "../../theme";
import { Disclosure } from "../teams/parts";
import { DiagramView } from "./DiagramView";

type Page<T> = { items: T[]; next: string | null };
const MAX_PLANNED_PAGES = 20;
const NOT_OBSERVED = "Not observed yet";
const evidenceLabel = (head: string | null, at: string) => head ? `From commit ${short(head)}, observed ${relative(at)}` : `Observed ${relative(at)}`;

/** Plain-language System sections for every repository in the workspace. */
export function SystemOverview({ connection, workspaceId, data, offline, onOpenComponent }: {
  connection: Connection; workspaceId: string; data: WorkspaceUnderstanding; offline: boolean; onOpenComponent: (componentId: string) => void;
}) {
  const knowledge = data.knowledge;
  const componentCount = new Map<string, number>();
  for (const component of knowledge?.components ?? []) if (!component.retired) for (const id of component.repositoryIds) componentCount.set(id, (componentCount.get(id) ?? 0) + 1);
  return <View style={s.stack}>
    {data.repositories.map(repo => {
      const brief = newestBrief(knowledge?.briefs ?? [], repo.id);
      const componentMap = (knowledge?.diagrams ?? []).find(diagram => diagram.kind === "components" && diagram.id === `components:${repo.id}`);
      return <RepositorySections key={repo.id} connection={connection} workspaceId={workspaceId} repo={repo} brief={brief} componentMap={componentMap}
        componentTotal={componentCount.get(repo.id) ?? 0} showName={data.repositories.length > 1} offline={offline} onOpenComponent={onOpenComponent} />;
    })}
    {!data.repositories.length ? <Text style={s.note}>No repositories are part of this workspace yet.</Text> : null}
  </View>;
}

function RepositorySections({ connection, workspaceId, repo, brief, componentMap, componentTotal, showName, offline, onOpenComponent }: {
  connection: Connection; workspaceId: string; repo: UnderstandingRepository; brief: KnowledgeRepositoryBrief | undefined; componentMap: DiagramGraph | undefined;
  componentTotal: number; showName: boolean; offline: boolean; onOpenComponent: (componentId: string) => void;
}) {
  const base = `/project-groups/${encodeURIComponent(workspaceId)}/understanding`;
  const artifacts = [...repo.current].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  const fallback = artifacts[0];
  const summary = brief?.brief.summary ?? fallback?.brief.summary;
  const systemMap = brief?.diagrams.find(diagram => diagram.kind === "system");
  const covered = systemMap ? new Set(systemMap.nodes.map(node => node.componentId).filter(Boolean)).size : 0;
  const showComponentMap = Boolean(componentMap && componentMap.nodes.length && (!systemMap || covered < componentTotal));
  const stateLine = repoStateLine(repo, brief);
  const briefEvidence = brief ? evidenceLabel(brief.head, brief.observedAt) : undefined;

  return <View style={s.repo}>
    {showName ? <Text style={s.repoName}>{repo.name}</Text> : null}

    <Section title="What this workspace is" evidence={briefEvidence ?? (fallback ? evidenceLabel(fallback.head, fallback.generatedAt) : NOT_OBSERVED)}>
      <Text selectable style={s.body}>{summary ?? "No explanation yet. The first observation runs within a few minutes of enrollment."}</Text>
    </Section>
    {brief?.state === "stale" ? <Text style={s.note}>Explanation is from an earlier commit; a refresh will update it.</Text> : null}

    <Section title="Architecture" evidence={briefEvidence ?? NOT_OBSERVED}>
      {systemMap ? <DiagramView graph={systemMap} onOpenComponent={onOpenComponent} /> : null}
      {brief?.brief.architecture.map((claim, index) => <Claim key={`architecture-${index}`} text={claim.text} citations={claim.citations} />)}
      {!systemMap && !brief?.brief.architecture.length ? <Text style={s.note}>The map appears after the first successful brief.</Text> : null}
    </Section>

    {showComponentMap && componentMap ? <Section title="Components" evidence={briefEvidence ?? NOT_OBSERVED}>
      <DiagramView graph={componentMap} onOpenComponent={onOpenComponent} />
    </Section> : null}

    <Changes base={base} connection={connection} repo={repo} brief={brief} artifacts={artifacts} offline={offline} evidence={briefEvidence ?? (fallback ? evidenceLabel(fallback.head, fallback.generatedAt) : NOT_OBSERVED)} />

    <Planned base={base} connection={connection} repo={repo} offline={offline} evidence={briefEvidence ?? (fallback ? evidenceLabel(fallback.head, fallback.generatedAt) : NOT_OBSERVED)} />

    {stateLine ? <Text style={s.notice}>{stateLine}</Text> : null}
  </View>;
}

function Changes({ base, connection, repo, brief, artifacts, offline, evidence }: {
  base: string; connection: Connection; repo: UnderstandingRepository; brief: KnowledgeRepositoryBrief | undefined; artifacts: UnderstandingArtifact[]; offline: boolean; evidence: string;
}) {
  const [earlier, setEarlier] = useState<UnderstandingArtifact[]>([]);
  const [next, setNext] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shown = new Set([...artifacts, ...earlier].map(artifact => artifact.id));
  const loadEarlier = async () => {
    setBusy(true); setError("");
    try {
      const cursor = next ? `&cursor=${encodeURIComponent(next)}` : "";
      const page = await api<Page<UnderstandingArtifact>>(connection, `${base}/briefs?repository=${encodeURIComponent(repo.id)}${cursor}`);
      setEarlier(previous => [...previous, ...page.items.filter(item => !shown.has(item.id))]);
      setNext(page.next);
    } catch {
      setError("Earlier briefs could not be loaded. Try again.");
    } finally { setBusy(false); }
  };
  const claims = brief?.brief.changes ?? [];
  const empty = !claims.length && !artifacts.length;
  return <Section title="What changed" evidence={evidence}>
    {claims.map((claim, index) => <Claim key={`change-${index}`} text={claim.text} citations={claim.citations} meta={brief ? `Generated ${date(brief.generatedAt)}` : undefined} />)}
    {[...artifacts, ...earlier].map(artifact => <ArtifactRow key={artifact.id} artifact={artifact} />)}
    {empty && next === undefined ? <Text style={s.note}>Nothing recorded since the first observation.</Text> : null}
    {next !== null ? <Pressable accessibilityRole="button" disabled={busy || offline} onPress={() => void loadEarlier()} style={[s.button, (busy || offline) && s.disabled]}>
      <Text style={s.buttonText}>{busy ? "Loading…" : "Show earlier briefs"}</Text>
    </Pressable> : <Text style={s.note}>No earlier briefs.</Text>}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
  </Section>;
}

function ArtifactRow({ artifact }: { artifact: UnderstandingArtifact }) {
  return <View style={s.row}>
    <Text style={s.rowTitle}>{artifact.head ? short(artifact.head) : "Revision not recorded"} · {artifact.sourceKind === "team" ? "team run" : "repository"}</Text>
    <Text style={s.meta}>Generated {date(artifact.generatedAt)}</Text>
    <Text selectable style={s.body}>{artifact.brief.summary}</Text>
    {artifact.brief.changes.map((claim, index) => <Claim key={`artifact-change-${index}`} text={claim.text} citations={claim.citations} />)}
    <Disclosure title={`System shape · ${artifact.brief.architecture.length}`}>
      {artifact.brief.architecture.length ? artifact.brief.architecture.map((claim, index) => <Claim key={`architecture-${index}`} text={claim.text} citations={claim.citations} />) : <Text style={s.note}>No architecture claims are included in this brief.</Text>}
    </Disclosure>
    <Disclosure title={`Review questions · ${artifact.brief.review.length}`}>
      {artifact.brief.review.length ? artifact.brief.review.map((question, index) => <View key={`review-${index}`} style={s.review}>
        <Text style={s.label}>{question.area} · {question.priority} priority</Text>
        {question.why ? <Text style={s.body}>{question.why}</Text> : null}
        <Text selectable style={s.body}>{question.question}</Text>
        {question.citations.length ? <Text selectable style={s.evidence}>Sources: {question.citations.map(citation => `${citation.source}:${citation.line}`).join(" · ")}</Text> : null}
      </View>) : <Text style={s.note}>No review questions are included in this brief.</Text>}
    </Disclosure>
    <Disclosure title={`Guidance · ${artifact.brief.guidance.length}`}>
      {artifact.brief.guidance.length ? artifact.brief.guidance.map((guidance, index) => <View key={`guidance-${index}`} style={s.review}>
        <Text style={s.label}>{guidance.basis === "documented" ? "Documented" : "Proposed"} guidance</Text>
        <Text selectable style={s.body}>{guidance.text}</Text>
        {guidance.citations.length ? <Text selectable style={s.evidence}>Sources: {guidance.citations.map(citation => `${citation.source}:${citation.line}`).join(" · ")}</Text> : null}
      </View>) : <Text style={s.note}>No agent guidance is included in this brief.</Text>}
    </Disclosure>
    <Disclosure title="Revision details">
      <Text selectable style={s.evidence}>Source project: {artifact.sourceProjectId}</Text>
      <Text selectable style={s.evidence}>Head: {artifact.head || "not recorded"}</Text>
      <Text selectable style={s.evidence}>Comparison base: {artifact.base || "not recorded"}</Text>
    </Disclosure>
    {artifact.evidence.length ? <Disclosure title={`Evidence · ${artifact.evidence.length}`}>
      {artifact.evidence.map((entry, index) => <Text selectable key={`evidence-${index}`} style={s.evidence}>{entry.source}:{entry.line} · {entry.text}</Text>)}
    </Disclosure> : null}
  </View>;
}

function Planned({ base, connection, repo, offline, evidence }: { base: string; connection: Connection; repo: UnderstandingRepository; offline: boolean; evidence: string }) {
  const [full, setFull] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const readFull = async (plan: UnderstandingPlan) => {
    setBusy(plan.workId); setError("");
    try {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PLANNED_PAGES; page++) {
        const result: Page<UnderstandingPlan> = await api<Page<UnderstandingPlan>>(connection, `${base}/planned?repository=${encodeURIComponent(repo.id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        const match = result.items.find(item => item.workId === plan.workId);
        if (match) { setFull(previous => ({ ...previous, [plan.workId]: match.text })); return; }
        if (!result.next) break;
        cursor = result.next;
      }
      setError("The full request could not be found.");
    } catch {
      setError("The full request could not be loaded. Try again.");
    } finally { setBusy(""); }
  };
  return <Section title="Planned" evidence={evidence}>
    {repo.planned.map((plan, index) => {
      const text = full[plan.workId] ?? plan.text;
      return <View key={`${plan.workId}/${index}`} style={s.row}>
        <Text style={s.rowTitle}>{plan.title}</Text>
        <Text style={s.meta}>{plan.status} · recorded {date(plan.updatedAt)}</Text>
        <Text selectable style={s.body}>{text}</Text>
        {plan.excerpt && full[plan.workId] === undefined ? <Pressable accessibilityRole="button" disabled={busy === plan.workId || offline} onPress={() => void readFull(plan)} style={[s.button, (busy === plan.workId || offline) && s.disabled]}>
          <Text style={s.buttonText}>{busy === plan.workId ? "Loading…" : "Read the full request"}</Text>
        </Pressable> : null}
      </View>;
    })}
    {!repo.planned.length ? <Text style={s.note}>No requests recorded for this repository.</Text> : null}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
  </Section>;
}

function Section({ title, evidence, children }: { title: string; evidence?: string; children: React.ReactNode }) {
  return <View style={s.section}>
    <Text accessibilityRole="header" style={s.sectionTitle}>{title}</Text>
    {children}
    {evidence ? <Text style={s.meta}>{evidence}</Text> : null}
  </View>;
}

function Claim({ text, citations, meta }: { text: string; citations: UnderstandingCitation[]; meta?: string }) {
  return <View style={s.claim}>
    <Text selectable style={s.body}>{text}</Text>
    {citations.length ? <Text selectable style={s.meta}>{citations.map(citation => `${citation.source}:${citation.line}`).join(" · ")}</Text> : null}
    {meta ? <Text style={s.meta}>{meta}</Text> : null}
  </View>;
}

function newestBrief(briefs: KnowledgeRepositoryBrief[], repositoryId: string) {
  return briefs.filter(brief => brief.repositoryId === repositoryId).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
}

/** The repository's work state; a stored repository brief means the first observation already happened. */
function repoStateLine(repo: UnderstandingRepository, brief: KnowledgeRepositoryBrief | undefined): string {
  if (repo.state === "updating") return "Updating now";
  if (repo.state === "failed") return repo.warnings[0] ?? "The latest refresh failed";
  if (repo.state === "empty") return brief ? "" : "Waiting for the first observation";
  if (repo.state === "unavailable") return "Source unavailable on the host";
  return "";
}

function short(value: string | null) { return value ? (value.length > 8 ? value.slice(0, 8) : value) : "not recorded"; }
function date(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? "time not recorded" : parsed.toLocaleString(); }
function relative(value: string) {
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return "at an unknown time";
  const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const s = StyleSheet.create({
  stack: { gap: 16 },
  repo: { gap: 14 },
  repoName: { fontSize: 17, fontWeight: "700", color: theme.colors.ink },
  section: { gap: 8, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  sectionTitle: { fontSize: 14, lineHeight: 20, fontWeight: "700", color: theme.colors.ink },
  body: { fontSize: 13, lineHeight: 19, color: theme.colors.ink, flexShrink: 1 },
  meta: { fontSize: 11, lineHeight: 16, color: theme.colors.mutedInk },
  note: { fontSize: 12, lineHeight: 18, color: theme.colors.mutedInk },
  evidence: { fontSize: 11, lineHeight: 16, color: theme.colors.secondaryInk, paddingLeft: 8 },
  claim: { gap: 3 },
  label: { fontSize: 11, lineHeight: 16, fontWeight: "700", color: theme.colors.secondaryInk },
  review: { gap: 5, paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  row: { gap: 5, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  rowTitle: { fontSize: 14, lineHeight: 19, fontWeight: "600", color: theme.colors.ink },
  notice: { fontSize: 12, lineHeight: 18, color: theme.colors.warningInk, backgroundColor: theme.colors.warningSurface, padding: 9, borderRadius: theme.radius.card },
  button: { alignSelf: "flex-start", minHeight: 34, justifyContent: "center", paddingHorizontal: 12, borderRadius: theme.radius.capsule, backgroundColor: theme.colors.secondarySurface },
  buttonText: { fontSize: 12, fontWeight: "600", color: theme.colors.forest },
  disabled: { opacity: 0.5 },
  error: { fontSize: 12, lineHeight: 18, color: theme.colors.error },
});
