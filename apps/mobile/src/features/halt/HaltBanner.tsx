import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Alert, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import * as Crypto from "expo-crypto";
import { ApiError, api, connectionKey, type Connection, type Me } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { Glyph } from "../../components/Icon";
import { theme } from "../../theme";
import { createHaltStore, haltNotice, haltSince, type HaltPlace, type HaltState, type HaltView } from "./model";

const halts = createHaltStore();

function useHalt(connection: Connection): HaltView | null {
  const key = connectionKey(connection);
  usePoll(async () => {
    const ticket = halts.begin();
    halts.record(key, ticket, await api<HaltView>(connection, "/halt"));
  }, 4000, [connection]);
  return useSyncExternalStore(halts.subscribe, useCallback(() => halts.get(key), [key]));
}

const HELD = "No new team, goal, mission, or routine work starts";

function facts(halt: HaltState) {
  return [`Since ${haltSince(halt.at)} · from ${halt.by}`, halt.reason ? `“${halt.reason}”` : ""].filter(Boolean);
}

type ReleaseTarget = { scope: "host" } | { scope: "project"; projectId: string };

export function HaltBanner({ connection, place, names, role, online, style }: {
  connection: Connection;
  place: HaltPlace;
  names?: (projectId: string) => string | undefined;
  role?: Me["role"];
  online?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = connectionKey(connection);
  const notice = haltNotice(useHalt(connection), place);
  const active = Boolean(notice);
  useEffect(() => {
    setError("");
  }, [key, role, active]);
  if (!notice) return null;
  const name = (projectId: string) => names?.(projectId) ?? projectId;
  let title: string, detail: string | undefined, lines: string[];
  if (notice.kind === "unreadable") {
    title = "Halted: the host cannot read its halt record";
    detail = "It holds every launch until it can read the record again.";
    lines = [];
  } else if (notice.kind === "host") {
    title = "Halted by the owner for the whole host";
    detail = `${HELD}; running goals and missions stay paused. Direct sessions keep running.`;
    lines = [...facts(notice.halt), ...(notice.projects.length ? [`Also halted on their own: ${notice.projects.map(halt => name(halt.projectId)).join(", ")}`] : [])];
  } else if (notice.kind === "project") {
    const single = typeof place === "object" && place.projectIds.length === 1;
    title = single ? "Halted by the owner for this project" : `Halted by the owner for ${notice.halts.map(halt => name(halt.projectId)).join(", ")}`;
    detail = `${HELD} here; running goals and missions stay paused. Direct sessions keep running.`;
    lines = notice.halts.flatMap(facts);
  } else {
    title = notice.halts.length === 1 ? "1 project halted by the owner" : `${notice.halts.length} projects halted by the owner`;
    lines = notice.halts.map(halt => [name(halt.projectId), `since ${haltSince(halt.at)}`, halt.reason ? `“${halt.reason}”` : ""].filter(Boolean).join(" · "));
  }
  const compact = notice.kind === "overview";
  const canRelease = role === "owner" && notice.kind !== "unreadable" && notice.kind !== "overview";
  const releaseTargets: { title: string; confirm: string; scope: ReleaseTarget }[] = notice.kind === "host"
    ? [{ title: "Release halt", confirm: "Release the host halt? Queued teams, goals, missions, and routines can launch again.", scope: { scope: "host" } }]
    : notice.kind === "project"
      ? notice.halts.map(halt => ({
        title: notice.halts.length === 1 ? "Release halt" : `Release halt (${name(halt.projectId)})`,
        confirm: `Release the halt for ${name(halt.projectId)}? Queued work in this project can launch again.`,
        scope: { scope: "project" as const, projectId: halt.projectId },
      }))
      : [];

  async function release(scope: ReleaseTarget) {
    setBusy(true);
    setError("");
    try {
      await api(connection, "/halt/release", { method: "POST", body: { requestId: Crypto.randomUUID(), ...scope } });
      const ticket = halts.begin();
      halts.record(key, ticket, await api<HaltView>(connection, "/halt"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.code === "remote-endpoint-denied") {
        setError("Releasing a halt is unavailable over relay/remote access. Use the paired host or CLI (infinite halt off).");
      } else {
        setError(err instanceof Error ? err.message : "Could not release halt.");
      }
    } finally {
      setBusy(false);
    }
  }

  return <View accessible accessibilityLabel={[title, detail, ...lines].filter(Boolean).join(". ")} style={[s.banner, compact && s.compact, style]}>
    <View style={s.head}>
      <Glyph name="pause" size={14} color={theme.colors.warningInk} />
      <Text style={s.title}>{title}</Text>
    </View>
    {detail ? <Text style={s.detail}>{detail}</Text> : null}
    {lines.map((line, index) => <Text key={index} style={s.meta} numberOfLines={compact ? 2 : 4}>{line}</Text>)}
    {canRelease ? <View style={s.actions}>
      {releaseTargets.map(target => <Button
        key={target.scope.scope === "host" ? "host" : target.scope.projectId}
        compact
        secondary
        busy={busy}
        disabled={busy || online === false}
        title={target.title}
        onPress={() => Alert.alert("Release halt?", target.confirm, [
          { text: "Keep halted", style: "cancel" },
          { text: "Release halt", onPress: () => void release(target.scope) },
        ])}
      />)}
    </View> : null}
    {error ? <Text style={s.error}>{error}</Text> : null}
  </View>;
}

const s = StyleSheet.create({
  banner: { borderRadius: theme.radius.panel, backgroundColor: theme.colors.warningSurface, paddingHorizontal: 13, paddingVertical: 11, gap: 4 },
  compact: { paddingVertical: 9 },
  head: { flexDirection: "row", alignItems: "center", gap: 7 },
  title: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: "600", color: theme.colors.warningInk },
  detail: { fontSize: 13, lineHeight: 18, color: theme.colors.warningInk },
  meta: { fontSize: 12, lineHeight: 17, color: theme.colors.warningInk },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  error: { fontSize: 12, lineHeight: 17, color: theme.colors.error, marginTop: 2 },
});
