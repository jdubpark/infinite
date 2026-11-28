import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { ApiError, type Api } from "./api";
import { useLiveRefresh } from "./live-refresh";

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
export type FuseCloseScope = { scope: "host" } | { scope: "project"; projectId: string };

export function isRemoteDenied(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.code === "remote-endpoint-denied";
}

export function useFuse(api: Api, identity: unknown) {
  const [view, setView] = useState<FuseView | null>(null);
  const [remoteDenied, setRemoteDenied] = useState(false);
  useEffect(() => {
    setView(null);
    setRemoteDenied(false);
  }, [identity]);
  const feed = useLiveRefresh(async (current) => {
    try {
      const next = await api<FuseView>("/fuse");
      if (current()) {
        setRemoteDenied(false);
        setView(next);
      }
    } catch (error) {
      if (isRemoteDenied(error)) {
        if (current()) {
          setRemoteDenied(true);
          setView(null);
        }
        return;
      }
      throw error;
    }
  }, 10_000, remoteDenied ? null : identity);
  return { view, remoteDenied, refresh: feed.refresh };
}

function periodLabel(window: FuseWindow | undefined): string {
  return window === "day" ? "daily" : window === "week" ? "weekly" : "hourly";
}

function causeText(scope: FuseScopeView): string {
  const trip = scope.trip;
  if (!trip) return "Spend fuse open";
  const period = periodLabel(trip.window);
  if (trip.cause === "unmeasurable") {
    return trip.window === "day" || trip.window === "week"
      ? `${period} spend record unreadable (closes when readable)`
      : "fuse baseline unreadable (closes when readable)";
  }
  if (trip.cause === "tokens") return `${period} token ceiling reached`;
  if (trip.cause === "list-usd") return `${period} list-price spend ceiling reached`;
  if (trip.cause === "spent-usd") return `${period} metered spend ceiling reached`;
  return trip.ownerClose ? "hourly launch limit reached (owner must close)" : "hourly launch limit reached (closes automatically)";
}

function formatMoney(usd: number): string {
  return usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4);
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

function periodCounts(label: string, reading: FusePeriodReading): string {
  if (!reading.available) return `${label}: unreadable`;
  const parts: string[] = [];
  if (reading.tokensLimit !== undefined) parts.push(`${formatTokens(reading.tokens)} / ${formatTokens(reading.tokensLimit)} tokens`);
  if (reading.listUsdLimit !== undefined) parts.push(`$${formatMoney(reading.listUsd)} / $${formatMoney(reading.listUsdLimit)} list`);
  if (reading.spentUsdLimit !== undefined) parts.push(`$${formatMoney(reading.spentUsd)} / $${formatMoney(reading.spentUsdLimit)} spent`);
  if (reading.unmeasuredSessions > 0) parts.push(`${reading.unmeasuredSessions} unmeasured`);
  return `${label}: ${parts.join(" · ")}`;
}

function countsText(scope: FuseScopeView): string {
  const parts = [`${scope.hour.launches}/${scope.hour.limit} launches/h`];
  if (scope.day) parts.push(periodCounts("day", scope.day));
  if (scope.week) parts.push(periodCounts("week", scope.week));
  return parts.join(" · ");
}

export function FuseBanner({ view, projectId, name, owner, online = true, remoteDenied = false, onClose, busy = false, error = "", className = "" }: {
  view: FuseView | null;
  projectId?: string;
  name: (projectId: string) => string;
  owner: boolean;
  online?: boolean;
  remoteDenied?: boolean;
  onClose?: (scope: FuseCloseScope) => Promise<void> | void;
  busy?: boolean;
  error?: string;
  className?: string;
}) {
  if (!view) return null;
  const hostOpen = view.host.state === "open";
  const openProjects = view.projects.filter(project => project.state === "open" && (projectId === undefined || project.projectId === projectId));
  if (!hostOpen && openProjects.length === 0 && !view.writeFailedAt) return null;

  const entries: { key: string; label: string; scope: FuseScopeView; target: FuseCloseScope }[] = [];
  if (hostOpen) entries.push({ key: "host", label: "host", scope: view.host, target: { scope: "host" } });
  for (const project of openProjects) {
    entries.push({ key: project.projectId, label: name(project.projectId), scope: project, target: { scope: "project", projectId: project.projectId } });
  }
  const title = entries.length === 1
    ? `Spend fuse open for ${entries[0].key === "host" ? "the host" : entries[0].label}`
    : entries.length > 1
      ? `Spend fuse open (${entries.length} scopes)`
      : "Spend fuse write failed";

  return <div className={`halt-banner fuse-banner ${className}`} role="status">
    <ShieldAlert size={18} aria-hidden="true" />
    <div className="halt-body">
      <p className="halt-title"><strong>{title}</strong></p>
      {entries.map(entry => <div key={entry.key} className="fuse-entry">
        <p className="halt-meta">
          {entries.length > 1 ? <b>{entry.key === "host" ? "Host" : entry.label}: </b> : null}
          {causeText(entry.scope)} · {countsText(entry.scope)}
          {owner && !remoteDenied && onClose && view.authoritative && entry.scope.trip?.cause !== "unmeasurable" && (
            <span className="halt-actions">
              <button
                type="button"
                className="halt-action-button"
                disabled={busy || !online}
                onClick={() => {
                  const targetLabel = entry.key === "host" ? "the host" : entry.label;
                  if (window.confirm(`Close the spend fuse for ${targetLabel}? Queued launches will resume.`)) void onClose(entry.target);
                }}
              >
                {busy ? "Closing…" : entries.length > 1 ? `Close fuse (${entry.key === "host" ? "host" : entry.label})` : "Close fuse"}
              </button>
            </span>
          )}
        </p>
      </div>)}
      {view.writeFailedAt && <p className="halt-note">The host could not record a launch at {new Date(view.writeFailedAt).toLocaleString()}. New team launches wait until it can.</p>}
      {error && <p className="halt-action-error" role="alert">{error}</p>}
    </div>
  </div>;
}
