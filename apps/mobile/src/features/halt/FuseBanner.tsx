import { useEffect, useState } from "react";
import { Alert, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { ApiError, api, connectionKey, type Connection, type Me } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { Glyph } from "../../components/Icon";
import { theme } from "../../theme";

export type FuseCause = "launch-rate" | "tokens" | "list-usd" | "spent-usd" | "unmeasurable";
export type FuseWindow = "hour" | "day" | "week";
export type FusePeriodReading = {
  tokens: number;
  tokensLimit?: number;
  listUsd: number;
  listUsdLimit?: number;
  spentUsd: number;
  spentUsdLimit?: number;
  unmeasuredSessions: number;
  available: boolean;
};
export type FuseScopeView = {
  state: "open" | "closed";
  trip?: { tripId?: string; cause: FuseCause; window?: FuseWindow; openedAt?: string; ownerClose: boolean };
  hour: { launches: number; limit: number };
  day?: FusePeriodReading;
  week?: FusePeriodReading;
};
export type FuseView = {
  authoritative: boolean;
  writeFailedAt?: string;
  host: FuseScopeView;
  projects: (FuseScopeView & { projectId: string })[];
};

type CloseScope = { scope: "host" } | { scope: "project"; projectId: string };

function periodLabel(window: FuseWindow | undefined): string {
  return window === "day" ? "daily" : window === "week" ? "weekly" : "hourly";
}

function causeLabel(scope: FuseScopeView): string {
  const trip = scope.trip;
  if (!trip) return "Spend fuse open";
  const period = periodLabel(trip.window);
  if (trip.cause === "unmeasurable") {
    return trip.window === "day" || trip.window === "week"
      ? `${period} spend record unreadable`
      : "fuse baseline unreadable";
  }
  if (trip.cause === "tokens") return `${period} token ceiling reached`;
  if (trip.cause === "list-usd") return `${period} list-price spend ceiling reached`;
  if (trip.cause === "spent-usd") return `${period} metered spend ceiling reached`;
  return trip.ownerClose ? "hourly launch limit reached (owner must close)" : "hourly launch limit reached";
}

function formatMoney(usd: number): string {
  return usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4);
}

function periodLine(label: string, reading: FusePeriodReading): string {
  if (!reading.available) return `${label}: unreadable`;
  const parts: string[] = [];
  if (reading.tokensLimit !== undefined) parts.push(`${reading.tokens.toLocaleString("en-US")}/${reading.tokensLimit.toLocaleString("en-US")} tok`);
  if (reading.listUsdLimit !== undefined) parts.push(`$${formatMoney(reading.listUsd)}/$${formatMoney(reading.listUsdLimit)} list`);
  if (reading.spentUsdLimit !== undefined) parts.push(`$${formatMoney(reading.spentUsd)}/$${formatMoney(reading.spentUsdLimit)} spent`);
  if (reading.unmeasuredSessions > 0) parts.push(`${reading.unmeasuredSessions} unmeasured`);
  return `${label}: ${parts.join(" · ")}`;
}

function summaryLine(scope: FuseScopeView): string {
  const parts = [causeLabel(scope), `${scope.hour.launches}/${scope.hour.limit} launches/h`];
  if (scope.day) parts.push(periodLine("day", scope.day));
  if (scope.week) parts.push(periodLine("week", scope.week));
  return parts.join(" · ");
}

export function FuseBanner({ connection, projectId, names, role, online, style }: {
  connection: Connection;
  projectId?: string;
  names?: (projectId: string) => string | undefined;
  role?: Me["role"];
  online?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deniedConnection, setDeniedConnection] = useState<string | null>(null);
  const key = connectionKey(connection);
  const denied = deniedConnection === key;
  const poll = usePoll(async () => {
    if (denied) return { denied: true as const, view: null };
    try {
      return { denied: false as const, view: await api<FuseView>(connection, "/fuse") };
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setDeniedConnection(key);
        return { denied: true as const, view: null };
      }
      throw err;
    }
  }, denied ? 3_600_000 : 10_000, [connection, denied]);

  const result = poll.data;
  const view = result && !result.denied ? result.view : null;
  const hostOpen = Boolean(view && view.host.state === "open");
  const openProjects = view
    ? view.projects.filter(project => project.state === "open" && (projectId === undefined || project.projectId === projectId))
    : [];
  const active = Boolean(view && (hostOpen || openProjects.length > 0 || view.writeFailedAt));
  useEffect(() => {
    setError("");
  }, [key, role, active]);
  if (!view || !active) return null;
  const name = (id: string) => names?.(id) ?? id;

  const entries: { key: string; label: string; scope: FuseScopeView; target: CloseScope }[] = [];
  if (hostOpen) entries.push({ key: "host", label: "host", scope: view.host, target: { scope: "host" } });
  for (const project of openProjects) {
    entries.push({ key: project.projectId, label: name(project.projectId), scope: project, target: { scope: "project", projectId: project.projectId } });
  }
  const title = entries.length === 1
    ? `Spend fuse open for ${entries[0].key === "host" ? "the host" : entries[0].label}`
    : entries.length > 1
      ? `Spend fuse open (${entries.length} scopes)`
      : "Spend fuse write failed";

  async function closeFuse(target: CloseScope) {
    setBusy(true);
    setError("");
    try {
      await api(connection, "/fuse/close", { method: "POST", body: target });
      await poll.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.code === "remote-endpoint-denied") {
        setError("Closing the spend fuse is unavailable over remote access. Use the paired host or CLI (infinite fuse close).");
      } else {
        setError(err instanceof Error ? err.message : "Could not close spend fuse.");
      }
    } finally {
      setBusy(false);
    }
  }

  return <View accessible accessibilityLabel={[title, ...entries.map(entry => summaryLine(entry.scope))].join(". ")} style={[s.banner, style]}>
    <View style={s.head}>
      <Glyph name="stop" size={14} color={theme.colors.warningInk} />
      <Text style={s.title}>{title}</Text>
    </View>
    {entries.map(entry => <View key={entry.key} style={s.entry}>
      <Text style={s.meta} numberOfLines={4}>
        {entries.length > 1 ? `${entry.key === "host" ? "Host" : entry.label}: ` : ""}
        {summaryLine(entry.scope)}
      </Text>
      {role === "owner" && view.authoritative && entry.scope.trip?.cause !== "unmeasurable" ? <View style={s.actions}>
        <Button
          compact
          secondary
          busy={busy}
          disabled={busy || online === false}
          title={entries.length > 1 ? `Close fuse (${entry.key === "host" ? "host" : entry.label})` : "Close fuse"}
          onPress={() => Alert.alert(
            "Close spend fuse?",
            `Close the spend fuse for ${entry.key === "host" ? "the host" : entry.label}? Queued launches will resume.`,
            [
              { text: "Keep open", style: "cancel" },
              { text: "Close fuse", onPress: () => void closeFuse(entry.target) },
            ],
          )}
        />
      </View> : null}
    </View>)}
    {view.writeFailedAt ? <Text style={s.meta}>The host could not record a launch. New team launches wait until it can.</Text> : null}
    {error ? <Text style={s.error}>{error}</Text> : null}
  </View>;
}

const s = StyleSheet.create({
  banner: { borderRadius: theme.radius.panel, backgroundColor: theme.colors.warningSurface, paddingHorizontal: 13, paddingVertical: 11, gap: 4 },
  head: { flexDirection: "row", alignItems: "center", gap: 7 },
  title: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: "600", color: theme.colors.warningInk },
  entry: { gap: 4 },
  meta: { fontSize: 12, lineHeight: 17, color: theme.colors.warningInk },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 },
  error: { fontSize: 12, lineHeight: 17, color: theme.colors.error, marginTop: 2 },
});
