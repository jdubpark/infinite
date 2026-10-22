import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import { createRemoteClient } from "@infinite/remote";
import { api, type Connection, type LogEvent, type SessionDetail } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { loadClientId } from "../../store/connection";
import { Button } from "../../components/Button";
import { Card } from "../../components/Glass";
import { theme } from "../../theme";
import { ROLE_NAMES, type TeamMember, type TeamView } from "./model";
import { Clamp, Disclosure, t } from "./parts";
import { briefText, briefTime, chooseBrief, controlEventText, plainScreen, relativeAge, summarySessionId, type TeamBriefView } from "./summary";

type BriefRow = { sessionId: string; status: TeamBriefView };

const roleName = (role: string) => ROLE_NAMES[role as TeamMember["role"]] ?? role;

/** Up to `limit` entries, then the rest on request. */
function Bullets({ title, items, limit = 3 }: { title: string; items: string[]; limit?: number }) {
  const [open, setOpen] = useState(false);
  const shown = items.map(item => item.trim()).filter(Boolean);
  if (!shown.length) return null;
  return <View style={s.group}>
    <Text style={s.heading}>{title}<Text style={s.count}>{`  ${shown.length}`}</Text></Text>
    {(open ? shown : shown.slice(0, limit)).map((item, index) => <View key={index} style={s.bullet}>
      <View style={s.dot} /><Text selectable style={[t.body, s.fill]}>{item}</Text>
    </View>)}
    {shown.length > limit ? <Pressable accessibilityRole="button" onPress={() => setOpen(value => !value)} hitSlop={8} style={s.more}>
      <Text style={s.moreText}>{open ? "Fewer" : `${shown.length - limit} more`}</Text>
    </Pressable> : null}
  </View>;
}

/**
 * The team brief, in the briefing contract's order: outcome, review questions,
 * changes, check evidence, and gaps, with system shape and guidance folded. It is not completion or
 * approval.
 */
export function UnderstandingSummary({ connection, team }: { connection: Connection; team: TeamView }) {
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
  const isBrief = Boolean(brief || chosen?.status.summary?.engine === "jevcode");
  const label = isBrief ? "Brief" : "Session summary";
  const source = [member ? roleName(member.role) : "", updating ? "updating" : age].filter(Boolean).join(" · ");

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
      setAskError(error instanceof Error ? error.message : "The brief could not be written.");
    } finally {
      client.close();
      askingRef.current = false;
      setAsking(false);
    }
  }

  return <Card style={s.summary}>
    <View accessibilityLiveRegion="polite" style={s.head}>
      {isBrief ? <View style={s.mark}><Text style={s.markText}>B</Text></View> : null}
      <Text style={s.engine}>{label}</Text>
      <Text style={[t.note, s.fill]} numberOfLines={1}>{source}</Text>
    </View>
    {!text ? <Text style={t.note}>{
      !poll.online && !poll.loading && !rows.length ? "Could not load."
        : !rows.length ? (targets ? "Loading…" : "No agent to summarize.")
          : updating ? "Writing…" : chosen?.status.error || "No summary yet."
    }</Text> : <>
      <Clamp text={brief?.summary || text} lines={5} />
      {brief?.review?.length ? <View style={s.group}>
        <Text style={s.heading}>Review first<Text style={s.count}>{`  ${brief.review.length}`}</Text></Text>
        {brief.review.map((item, index) => <View key={index} style={s.review}>
          <View style={s.reviewHead}>
            <Text style={s.rank}>{index + 1}</Text>
            <Text selectable style={[t.strong, s.fill]} numberOfLines={2}>{item.area}</Text>
            {item.priority ? <Text style={[s.priority, item.priority === "high" && s.priorityHigh]}>{item.priority}</Text> : null}
          </View>
          {item.why ? <Text selectable style={t.note} numberOfLines={3}>{item.why}</Text> : null}
          {item.question ? <Text selectable style={s.question}>{item.question}</Text> : null}
        </View>)}
      </View> : null}
      <Bullets title="What changed" items={(brief?.changes ?? []).map(item => item.text ?? "")} />
      <Bullets title="Check evidence" items={(brief?.checks ?? []).map(item => item.text ?? "")} />
      <Bullets title="Gaps" items={brief?.unknowns ?? []} />
      {brief?.architecture?.length ? <Disclosure title={`System shape · ${brief.architecture.length}`}>
        {brief.architecture.map((item, index) => <Text key={index} selectable style={t.body}>• {item.text}</Text>)}
      </Disclosure> : null}
      {brief?.guidance?.length ? <Disclosure title={`Guidance for agents · ${brief.guidance.length}`}>
        {brief.guidance.map((item, index) => <Text key={index} selectable style={t.body}>• {[item.basis, item.text].filter(Boolean).join(": ")}</Text>)}
      </Disclosure> : null}
      <Text style={t.note}>Not completion or approval.</Text>
    </>}
    {askError ? <Text accessibilityRole="alert" style={t.error}>{askError}</Text> : null}
    {canAsk && chosen ? <Button compact secondary title={asking ? "Writing… a few minutes" : "Write brief"} disabled={asking} onPress={() => void ask(chosen.sessionId)} /> : null}
  </Card>;
}

/** 14 lines of 16 px fit the 260 px screen box after its 12 px padding; more would clip the bottom prompt. */
const SCREEN_LINES = 14;

/** One agent's current screen and recent control events. */
export function AgentLog({ connection, member, live, onOpen, onStaleChange }: { connection: Connection; member: TeamMember; live: boolean; onOpen: () => void; onStaleChange?: (stale: boolean) => void }) {
  const poll = usePoll(async () => {
    const detail = await api<SessionDetail>(connection, `/sessions/${member.sessionId}`);
    const page = await api<{ events: LogEvent[] }>(connection, `/sessions/${member.sessionId}/events?after=${Math.max(0, detail.seq - 80)}&types=lifecycle,signal,input-result&limit=80`);
    return { sessionId: member.sessionId, screen: detail.screen ?? "", events: page.events ?? [] };
  }, 2500, [connection, member.sessionId]);
  useEffect(() => {
    onStaleChange?.(poll.stale);
    return () => onStaleChange?.(false);
  }, [onStaleChange, poll.stale]);
  const log = poll.data?.sessionId === member.sessionId ? poll.data : null;
  const screen = log ? plainScreen(log.screen, SCREEN_LINES) : "";
  return <View style={s.log}>
    <ScrollView horizontal style={s.screen} contentContainerStyle={s.screenContent}>
      <Text selectable style={s.screenText}>{log ? screen || (live ? "Waiting for output…" : "No screen recorded.") : "Loading…"}</Text>
    </ScrollView>
    {log?.events.length ? [...log.events].slice(-5).reverse().map(event => <View key={event.seq} style={s.event}>
      <Text style={s.eventTime} numberOfLines={1}>{new Date(event.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Text>
      <Text selectable style={[t.note, s.fill]} numberOfLines={2}>{controlEventText(event)}</Text>
    </View>) : log ? <Text style={t.note}>No recent events.</Text> : null}
    <Button compact secondary glyph="terminal" title="Open session" onPress={onOpen} />
  </View>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  summary: { gap: 10 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  mark: { width: 20, height: 20, borderRadius: 6, backgroundColor: theme.colors.forest, alignItems: "center", justifyContent: "center" },
  markText: { fontSize: 12, fontWeight: "800", color: theme.colors.white, includeFontPadding: false },
  engine: { fontSize: 13, fontWeight: "700", color: theme.colors.ink },
  group: { gap: 6 },
  heading: { fontSize: 13, fontWeight: "700", color: theme.colors.ink },
  count: { fontWeight: "400", color: theme.colors.mutedInk },
  bullet: { flexDirection: "row", gap: 9, alignItems: "flex-start" },
  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 8, backgroundColor: theme.colors.fieldRule },
  more: { paddingVertical: 2, alignSelf: "flex-start" },
  moreText: { fontSize: 13, fontWeight: "600", color: theme.colors.forest },
  review: { gap: 3, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.rule },
  reviewHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  rank: { width: 20, height: 20, borderRadius: 10, textAlign: "center", lineHeight: 20, fontSize: 11, fontWeight: "700", color: theme.colors.white, backgroundColor: theme.colors.forest, overflow: "hidden" },
  priority: { fontSize: 10, fontWeight: "700", textTransform: "uppercase", color: theme.colors.mutedInk, backgroundColor: theme.colors.screenSurface, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: "hidden" },
  priorityHigh: { color: theme.colors.warningInk, backgroundColor: theme.colors.warningSurface },
  question: { fontSize: 13, lineHeight: 19, color: theme.colors.secondaryInk, fontStyle: "italic" },
  log: { gap: 8, paddingBottom: 10 },
  screen: { borderRadius: theme.radius.panel, backgroundColor: theme.colors.terminalSurface, maxHeight: 260 },
  screenContent: { padding: 12 },
  screenText: { fontFamily: theme.mono, fontSize: 11, lineHeight: 16, color: theme.colors.terminalInk },
  event: { flexDirection: "row", gap: 10 },
  eventTime: { width: 64, fontSize: 11, lineHeight: 17, color: theme.colors.mutedInk, fontVariant: ["tabular-nums"] },
});
