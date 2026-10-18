import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import { createRemoteClient } from "@infinite/remote";
import { api, type Connection, type LogEvent, type SessionDetail } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { loadClientId } from "../../store/connection";
import { Button } from "../../components/Button";
import { theme } from "../../theme";
import { ROLE_NAMES, shortDate, type TeamMember, type TeamView } from "./model";
import { Clamp, Disclosure, t } from "./parts";
import { briefText, briefTime, chooseBrief, controlEventText, plainScreen, relativeAge, summarySessionId, type TeamBriefView } from "./summary";

type BriefRow = { sessionId: string; status: TeamBriefView };
export type TeamViewMode = "summary" | "logs";

const roleName = (role: string) => ROLE_NAMES[role as TeamMember["role"]] ?? role;
const live = (member: TeamMember) => member.status === "running" || member.status === "waiting";

/** The two team views as one segmented control, so the current view is always visible. */
export function ViewSwitch({ mode, onChange }: { mode: TeamViewMode; onChange: (mode: TeamViewMode) => void }) {
  const options: [TeamViewMode, string][] = [["summary", "Summary"], ["logs", "Review logs"]];
  return <View accessibilityRole="tablist" style={s.switch}>
    {options.map(([value, label]) => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: mode === value }} onPress={() => onChange(value)}
      style={[s.switchOption, mode === value && s.switchActive]}>
      <Text style={[s.switchText, mode === value && s.switchTextActive]}>{label}</Text>
    </Pressable>)}
  </View>;
}

/** Up to `limit` entries, then the rest on request. */
function Bullets({ title, items, limit = 3 }: { title: string; items: string[]; limit?: number }) {
  const [open, setOpen] = useState(false);
  const shown = items.map(item => item.trim()).filter(Boolean);
  if (!shown.length) return null;
  return <View style={s.group}>
    <Text style={s.heading}>{title}<Text style={s.count}>{`  ${shown.length}`}</Text></Text>
    {(open ? shown : shown.slice(0, limit)).map((item, index) => <View key={index} style={s.bullet}>
      <Text style={s.dot}>•</Text><Text selectable style={[t.body, s.fill]}>{item}</Text>
    </View>)}
    {shown.length > limit ? <Pressable accessibilityRole="button" onPress={() => setOpen(value => !value)} style={s.more}>
      <Text style={s.moreText}>{open ? "Show fewer" : `Show ${shown.length - limit} more`}</Text>
    </Pressable> : null}
  </View>;
}

/**
 * The Jevcode reading of the team, in the briefing contract's order: outcome, system shape, ranked
 * review questions, changes, check evidence, guidance, and gaps. It is not completion or approval.
 */
export function JevcodeSummary({ connection, team }: { connection: Connection; team: TeamView }) {
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState("");
  const [asked, setAsked] = useState<BriefRow | null>(null);
  const askingRef = useRef(false);
  const current = team.members.filter(member => member.revision === team.revision);
  const targets = (current.length ? current : team.members).slice(0, 6).map(member => member.sessionId).join(",");
  // Each poll records when it ran, so the summary's age advances without reading the clock in render.
  const poll = usePoll(async () => {
    const rows: BriefRow[] = await Promise.all(targets.split(",").filter(Boolean).map(async sessionId => {
      try { return { sessionId, status: await api<TeamBriefView>(connection, `/sessions/${sessionId}/summary?status=1`) }; }
      catch (error) { return { sessionId, status: { state: "unknown", error: error instanceof Error ? error.message : "The summary could not be loaded." } }; }
    }));
    return { rows, at: Date.now() };
  }, 4000, [connection, targets]);
  const polled = poll.data?.rows ?? [];
  // A summary written on request shows at once and stays until a poll returns a written one.
  const keep = asked && !briefText(polled.find(row => row.sessionId === asked.sessionId)?.status);
  const rows = keep ? [...polled.filter(row => row.sessionId !== asked.sessionId), asked] : polled;
  const chosen = chooseBrief(rows, summarySessionId(team.members, team.revision));
  const member = team.members.find(item => item.sessionId === chosen?.sessionId);
  const brief = chosen?.status.summary?.repository?.brief;
  const text = briefText(chosen?.status);
  const state = chosen?.status.state;
  const updating = state === "pending" || state === "running";
  const canAsk = !text && (state === "empty" || state === "failed") && Boolean(chosen?.sessionId);
  const written = briefTime(chosen?.status);
  const age = poll.data ? relativeAge(written, poll.data.at) : "";
  const source = [brief || chosen?.status.summary?.engine === "jevcode" ? "Jevcode" : "Session summary", member ? roleName(member.role) : "", written ? shortDate(written) : "", age].filter(Boolean).join(" · ");

  async function ask(sessionId: string) {
    if (askingRef.current) return;
    askingRef.current = true;
    setAsking(true);
    setAskError("");
    // A repository brief can take minutes, longer than the shared client's request limit.
    const client = createRemoteClient(connection, { randomBytes: Crypto.getRandomBytes, requestTimeoutMs: 180000 });
    try {
      const summary = await client.request<TeamBriefView["summary"]>(`/sessions/${sessionId}/summary?after=0`, { headers: { "X-Infinite-Client": await loadClientId() } });
      const ready = Boolean(summary?.repository?.brief?.summary || summary?.text);
      setAsked({ sessionId, status: { state: ready ? "ready" : "empty", summary, ...(ready ? {} : { error: "No recorded chat is available for a repository brief." }) } });
    } catch (error) {
      setAskError(error instanceof Error ? error.message : "Jevcode could not write a summary.");
    } finally {
      client.close();
      askingRef.current = false;
      setAsking(false);
    }
  }

  return <View style={[t.card, s.summary]} accessibilityLiveRegion="polite">
    <Text style={s.kicker}>JEVCODE SUMMARY</Text>
    {source ? <Text style={t.note}>{source}</Text> : null}
    {!text ? <Text style={t.body}>{
      !poll.online && !poll.loading && !rows.length ? "The Jevcode summary could not be loaded."
        : !rows.length ? (targets ? "Loading the Jevcode summary…" : "No agent session is available for a summary.")
          : updating ? "Jevcode is writing the summary." : chosen?.status.error || "No Jevcode summary yet."
    }</Text> : <>
      {updating ? <Text style={t.note}>Jevcode is updating this summary.</Text> : null}
      <Clamp text={brief?.summary || text} lines={8} />
      {brief?.architecture?.length ? <Disclosure title={`System shape (${brief.architecture.length})`}>
        {brief.architecture.map((item, index) => <Text key={index} selectable style={t.body}>• {item.text}</Text>)}
      </Disclosure> : null}
      {brief?.review?.length ? <View style={s.group}>
        <Text style={s.heading}>Review first<Text style={s.count}>{`  ${brief.review.length}`}</Text></Text>
        {brief.review.map((item, index) => <View key={index} style={s.review}>
          <View style={s.reviewHead}>
            <Text style={s.rank}>{index + 1}</Text>
            {item.priority ? <Text style={[s.priority, item.priority === "high" && s.priorityHigh]}>{item.priority}</Text> : null}
            <Text selectable style={[t.strong, s.fill]}>{item.area}</Text>
          </View>
          {item.why ? <Text selectable style={t.body}>{item.why}</Text> : null}
          {item.question ? <Text selectable style={s.question}>Ask: {item.question}</Text> : null}
        </View>)}
      </View> : null}
      <Bullets title="What changed" items={(brief?.changes ?? []).map(item => item.text ?? "")} />
      <Bullets title="Check evidence" items={(brief?.checks ?? []).map(item => item.text ?? "")} />
      {brief?.guidance?.length ? <Disclosure title={`Guidance for agents (${brief.guidance.length})`}>
        {brief.guidance.map((item, index) => <Text key={index} selectable style={t.body}>• {[item.basis, item.text].filter(Boolean).join(": ")}</Text>)}
      </Disclosure> : null}
      <Bullets title="Gaps and unknowns" items={brief?.unknowns ?? []} />
      <Text style={t.note}>This is the Jevcode agent’s reading of recorded activity and the repository. It is not completion or approval.</Text>
    </>}
    {askError ? <Text accessibilityRole="alert" style={t.error}>{askError}</Text> : null}
    {canAsk && chosen ? <Button title={asking ? "Asking Jevcode… this can take a few minutes" : "Ask Jevcode for a summary"} disabled={asking} onPress={() => void ask(chosen.sessionId)} /> : null}
  </View>;
}

/** One agent's terminal screen and recent control events, with every agent one tap away. */
export function ReviewLogs({ connection, team, agentId, onSelect, onOpen, onBack }: {
  connection: Connection; team: TeamView; agentId: string; onSelect: (memberId: string) => void; onOpen: (sessionId: string) => void; onBack: () => void;
}) {
  // Current revision first; within it, live agents first, then the team's role order.
  const order = ["project-manager", "scout", "implementer", "integrator", "reviewer", "delivery"];
  const agents = [...team.members].sort((a, b) => Number(b.revision === team.revision) - Number(a.revision === team.revision)
    || Number(live(b)) - Number(live(a)) || order.indexOf(a.role) - order.indexOf(b.role));
  const selected = agents.find(member => member.memberId === agentId)
    ?? agents.find(member => member.revision === team.revision && live(member)) ?? agents[0];
  const index = selected ? agents.indexOf(selected) : -1;
  const poll = usePoll(async () => {
    if (!selected) return null;
    const detail = await api<SessionDetail>(connection, `/sessions/${selected.sessionId}`);
    const page = await api<{ events: LogEvent[] }>(connection, `/sessions/${selected.sessionId}/events?after=${Math.max(0, detail.seq - 80)}&types=lifecycle,signal,input-result&limit=80`);
    return { sessionId: selected.sessionId, screen: detail.screen ?? "", events: page.events ?? [] };
  }, 2500, [connection, selected?.sessionId]);
  const log = poll.data?.sessionId === selected?.sessionId ? poll.data : null;
  const screen = log ? plainScreen(log.screen, 40) : "";
  const step = (by: number) => { if (agents.length) onSelect(agents[(index + by + agents.length) % agents.length]!.memberId); };

  if (!selected) return <View style={s.group}>
    <Text style={t.body}>This run has no agents yet.</Text>
    <Button title="Back to summary" secondary onPress={onBack} />
  </View>;
  return <View style={s.group}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
      {agents.map(member => {
        const active = member.memberId === selected.memberId;
        return <Pressable key={member.memberId} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={`${roleName(member.role)}, ${member.status}`}
          onPress={() => onSelect(member.memberId)} style={[s.chip, active && s.chipActive]}>
          <View style={s.chipHead}>
            <View style={[s.statusDot, live(member) && s.statusLive]} />
            <Text style={[s.chipTitle, active && s.chipTitleActive]}>{roleName(member.role)}</Text>
          </View>
          <Text style={[s.chipMeta, active && s.chipTitleActive]}>{member.status}{member.revision === team.revision ? "" : ` · rev ${member.revision}`}</Text>
        </Pressable>;
      })}
    </ScrollView>
    {agents.length > 1 ? <View style={s.stepper}>
      <Button title="‹ Previous" secondary onPress={() => step(-1)} />
      <Text style={t.note}>Agent {index + 1} of {agents.length}</Text>
      <Button title="Next ›" secondary onPress={() => step(1)} />
    </View> : null}
    <View style={s.agentHead}>
      <Text style={t.strong}>{roleName(selected.role)} · {selected.status}</Text>
      <Text style={t.note} numberOfLines={2}>{selected.title}{selected.taskId ? ` · ${selected.taskId}` : ""}{selected.revision === team.revision ? "" : ` · revision ${selected.revision}`}</Text>
      {selected.stoppedReason ? <Text style={t.warning}>Stopped: {selected.stoppedReason}</Text> : null}
    </View>
    {!poll.online && !poll.loading ? <Text style={t.warning}>This agent’s log could not be refreshed. Showing the last received screen.</Text> : null}
    <ScrollView horizontal style={s.screen} contentContainerStyle={s.screenContent}>
      <Text selectable style={s.screenText}>{log ? screen || (live(selected) ? "Waiting for output…" : "No screen is recorded for this agent.") : "Loading the screen…"}</Text>
    </ScrollView>
    <Text style={s.heading}>Recent events</Text>
    {log ? log.events.length ? [...log.events].slice(-8).reverse().map(event => <View key={event.seq} style={s.event}>
      <Text style={s.eventTime}>{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
      <Text selectable style={[t.body, s.fill]}>{controlEventText(event)}</Text>
    </View>) : <Text style={t.note}>No recent control events.</Text> : null}
    <View style={s.row}>
      <Button title="Open session" secondary onPress={() => onOpen(selected.sessionId)} />
      <Button title="Back to summary" secondary onPress={onBack} />
    </View>
  </View>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  switch: { flexDirection: "row", padding: 3, gap: 3, borderRadius: theme.radius.control + 2, backgroundColor: theme.colors.secondarySurface, marginHorizontal: theme.space.section, marginBottom: theme.space.label },
  switchOption: { flex: 1, minHeight: 40, borderRadius: theme.radius.control, alignItems: "center", justifyContent: "center" },
  switchActive: { backgroundColor: theme.colors.white, borderWidth: 1, borderColor: theme.colors.rule },
  switchText: { fontSize: 14, fontWeight: "600", color: theme.colors.mutedInk },
  switchTextActive: { color: theme.colors.forest },
  summary: { gap: 10, marginTop: theme.space.compact },
  kicker: { fontSize: 11, letterSpacing: 1, fontWeight: "700", color: theme.colors.forest },
  group: { gap: 8, marginTop: theme.space.compact },
  heading: { fontSize: 14, fontWeight: "600", color: theme.colors.ink },
  count: { fontWeight: "400", color: theme.colors.mutedInk },
  bullet: { flexDirection: "row", gap: 8 },
  dot: { fontSize: 15, lineHeight: 23, color: theme.colors.mutedInk },
  more: { paddingVertical: 6 },
  moreText: { fontSize: 13, fontWeight: "600", color: theme.colors.secondaryInk },
  review: { gap: 4, paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.colors.rule },
  reviewHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  rank: { width: 22, height: 22, borderRadius: 11, textAlign: "center", lineHeight: 22, fontSize: 12, fontWeight: "700", color: theme.colors.white, backgroundColor: theme.colors.forest, overflow: "hidden" },
  priority: { fontSize: 11, fontWeight: "700", textTransform: "uppercase", color: theme.colors.mutedInk, backgroundColor: theme.colors.screenSurface, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: "hidden" },
  priorityHigh: { color: theme.colors.warningInk, backgroundColor: theme.colors.warningSurface },
  question: { fontSize: 14, lineHeight: 21, color: theme.colors.secondaryInk, fontStyle: "italic" },
  chips: { gap: 8, paddingVertical: 2 },
  chip: { minWidth: 112, paddingHorizontal: 12, paddingVertical: 8, borderRadius: theme.radius.control, borderWidth: 1, borderColor: theme.colors.rule, backgroundColor: theme.colors.white },
  chipActive: { backgroundColor: theme.colors.forest, borderColor: theme.colors.forest },
  chipHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  chipTitle: { fontSize: 14, fontWeight: "700", color: theme.colors.secondaryInk },
  chipTitleActive: { color: theme.colors.white },
  chipMeta: { fontSize: 12, color: theme.colors.mutedInk, marginTop: 2 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.fieldRule },
  statusLive: { backgroundColor: theme.colors.running },
  stepper: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  agentHead: { gap: 2 },
  screen: { borderRadius: theme.radius.panel, backgroundColor: theme.colors.terminalSurface },
  screenContent: { padding: 12 },
  screenText: { fontFamily: theme.mono, fontSize: 12, lineHeight: 18, color: theme.colors.terminalInk },
  event: { flexDirection: "row", gap: 10, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: theme.colors.rule },
  eventTime: { width: 52, fontFamily: theme.mono, fontSize: 12, lineHeight: 23, color: theme.colors.mutedInk },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: theme.space.compact },
});
