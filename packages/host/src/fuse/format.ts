import { formatUsd } from "../usage.js";
import type { FuseScopeView, FuseView } from "./service.js";
import type { FusePeriodReading } from "./types.js";

function periodSummary(label: string, reading: FusePeriodReading): string {
  if (!reading.available) return `${label}: unmeasurable`;
  const parts: string[] = [];
  if (reading.tokensLimit !== undefined) parts.push(`${Number(reading.tokens)}/${Number(reading.tokensLimit)} tokens`);
  if (reading.listUsdLimit !== undefined) parts.push(`$${formatUsd(reading.listUsd)}/$${formatUsd(reading.listUsdLimit)} list`);
  if (reading.spentUsdLimit !== undefined) parts.push(`$${formatUsd(reading.spentUsd)}/$${formatUsd(reading.spentUsdLimit)} spent`);
  if (reading.unmeasuredSessions > 0) parts.push(`${Number(reading.unmeasuredSessions)} unmeasured`);
  return `${label}: ${parts.join(", ")}`;
}

function scopePeriods(scope: FuseScopeView): string {
  const periods: string[] = [];
  if (scope.day) periods.push(periodSummary("day", scope.day));
  if (scope.week) periods.push(periodSummary("week", scope.week));
  return periods.length > 0 ? `; ${periods.join("; ")}` : "";
}

function openCause(scope: FuseScopeView): string {
  const trip = scope.trip;
  if (trip?.cause === "unmeasurable") {
    return trip.window === "day" || trip.window === "week"
      ? `${trip.window} spend unreadable, it closes once it can be read`
      : "launch record unreadable, it closes once it can be read";
  }
  if (trip?.cause === "tokens") return `${trip.window ?? "spend"} token limit, the owner must close it`;
  if (trip?.cause === "list-usd") return `${trip.window ?? "spend"} list-price spend limit, the owner must close it`;
  if (trip?.cause === "spent-usd") return `${trip.window ?? "spend"} metered spend limit, the owner must close it`;
  return trip?.ownerClose ? "launch rate, the owner must close it" : "launch rate, it closes on its own";
}

export function formatFuseLines(view: FuseView, clean: (value: string) => string): string[] {
  const line = (name: string, scope: FuseScopeView) => {
    const periods = scopePeriods(scope);
    if (scope.state === "closed") {
      return `${name}: closed, ${Number(scope.hour.launches)} of ${Number(scope.hour.limit)} launches in the last hour${periods}`;
    }
    return `${name}: open (${clean(openCause(scope))})${periods}`;
  };
  return [
    line("Host", view.host),
    ...view.projects.map(project => line(`Project ${clean(String(project.projectId))}`, project)),
    ...(view.writeFailedAt ? [`The host could not record a launch at ${clean(String(view.writeFailedAt))}. New team launches wait until it can.`] : []),
  ];
}
