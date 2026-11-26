import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useApi, type RepairLoopReport } from "./api";
import { useLiveRefresh } from "./live-refresh";
import {
  buildRepairMetricsViewModel,
  classifyRepairLoopError,
  DEFAULT_REPAIR_WINDOW_DAYS,
  repairLoopsPath,
  type RepairLoopLoadError,
} from "./repair-metrics-model";

export function RepairMetricsPanel({ projectId, days = DEFAULT_REPAIR_WINDOW_DAYS }: { projectId?: string; days?: number }) {
  const api = useApi();
  const [report, setReport] = useState<RepairLoopReport | null>(null);
  const [loadError, setLoadError] = useState<RepairLoopLoadError | null>(null);

  const view = useLiveRefresh(async current => {
    try {
      const next = await api<RepairLoopReport>(repairLoopsPath({ projectId, days }));
      if (current()) {
        setReport(next);
        setLoadError(null);
      }
      return 30000;
    } catch (error) {
      const classified = classifyRepairLoopError(error);
      if (current()) {
        setLoadError(classified);
        if (classified.kind === "unsupported" || classified.kind === "unavailable") {
          setReport(null);
        }
      }
      if (classified.kind === "unsupported") return 300000;
      if (classified.kind === "unavailable") return 60000;
      throw error;
    }
  }, 30000, `${projectId ?? "all"}:${days}`);

  const headingMeta = report
    ? `last ${report.windowDays} days · ${report.totals.runsExamined} ${report.totals.runsExamined === 1 ? "run" : "runs"} examined`
    : `last ${days} days${projectId ? " · project" : ""}`;

  if (loadError?.kind === "unsupported" || loadError?.kind === "unavailable") {
    return (
      <section className="cost-section repair-section" aria-label="Repair loops">
        <div className="cost-section-heading">
          <h2>Repair loops</h2>
          <span className="quiet">{headingMeta}</span>
        </div>
        <p className="quiet repair-unavailable" role="status">{loadError.message}</p>
      </section>
    );
  }

  if (!report) {
    return (
      <section className="cost-section repair-section" aria-label="Repair loops">
        <div className="cost-section-heading">
          <h2>Repair loops</h2>
          <span className="quiet">{headingMeta}</span>
        </div>
        {view.failed || loadError?.kind === "failed" ? (
          <p className="cost-failure" role="status">
            {loadError?.message ?? "Repair-loop metrics could not be loaded."}{" "}
            <button type="button" className="text-button" onClick={view.refresh}>
              <RefreshCw size={14} />Try again
            </button>
          </p>
        ) : (
          <p className="quiet" role="status">Loading repair loops…</p>
        )}
      </section>
    );
  }

  const vm = buildRepairMetricsViewModel(report);

  return (
    <section className="cost-section repair-section" aria-label="Repair loops">
      <div className="cost-section-heading">
        <h2>Repair loops</h2>
        <span className="quiet">{headingMeta}</span>
      </div>

      <div className="repair-gate" role="status">
        <span className={`repair-gate-badge ${vm.gate.baselineGateMet ? "is-met" : "is-pending"}`}>
          {vm.gate.statusLabel}
        </span>
        <span className="repair-gate-detail">{vm.gate.detailText}</span>
      </div>

      <ul className="repair-kpis">
        <li className="repair-kpi">
          <span className="repair-kpi-label">Denominator loops</span>
          <strong className="repair-kpi-figure">{vm.loopsTotal}</strong>
          <span className="repair-kpi-sub">
            {vm.outcomes.resolved} resolved · {vm.outcomes.inProgress} in progress · {vm.outcomes.unresolved} unresolved
          </span>
        </li>
        <li className="repair-kpi">
          <span className="repair-kpi-label">Resolution latency</span>
          <strong className={`repair-kpi-figure${vm.latency.hasResolvedLatency ? "" : " cost-dash"}`}>
            {vm.latency.medianText}
          </strong>
          <span className="repair-kpi-sub">p90 {vm.latency.p90Text} · resolved loops</span>
        </li>
        <li className="repair-kpi">
          <span className="repair-kpi-label">Measured repair cost</span>
          <strong className={`repair-kpi-figure${vm.cost.hasMeasuredCost ? "" : " cost-dash"}`}>
            {vm.cost.medianUsdText}
          </strong>
          <span className="repair-kpi-sub">
            {vm.cost.medianTokensText === "Unmeasured" ? "Unmeasured tokens" : `${vm.cost.medianTokensText} median tokens`}
            {vm.coverage.unmeasuredLoops > 0 && (
              <> · <span className="cost-badge">{vm.coverage.unmeasuredLoops} unmeasured</span></>
            )}
          </span>
        </li>
        <li className="repair-kpi">
          <span className="repair-kpi-label">Overhead & causes</span>
          <strong className="repair-kpi-figure">
            {vm.overhead.coldReplacements} cold · {vm.overhead.failedResumes} resume
          </strong>
          <span className="repair-kpi-sub">
            {vm.causes.map(item => `${item.label} ${item.count}`).join(" · ")}
          </span>
        </li>
      </ul>

      {(vm.coverage.unmeasuredLoops > 0 || vm.coverage.unmeasuredMembers > 0) && (
        <p className="repair-note quiet">
          <span className="cost-badge">{vm.coverage.unmeasuredLoops} unmeasured</span>{" "}
          {vm.coverage.unmeasuredLoops} of {vm.loopsTotal} loops ({vm.coverage.unmeasuredMembers} unmeasured{" "}
          {vm.coverage.unmeasuredMembers === 1 ? "member" : "members"}) lack complete pricing and are excluded from token and USD medians, never counted as $0.
        </p>
      )}

      {vm.samples.length > 0 ? (
        <table className="cost-models repair-table">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Cause</th>
              <th scope="col">Outcome</th>
              <th scope="col">Attempts</th>
              <th scope="col">Duration</th>
              <th scope="col">Measured cost</th>
            </tr>
          </thead>
          <tbody>
            {vm.samples.map(sample => (
              <tr key={sample.key}>
                <th scope="row" data-label="Run">
                  <strong><code>{sample.shortRunId}</code> · r{sample.revision}</strong>
                  <small>
                    {!projectId ? `${sample.projectId} · ` : ""}
                    {sample.failedCommitShort ? `${sample.failedCommitShort}${sample.passingCommitShort ? ` -> ${sample.passingCommitShort}` : ""}` : sample.startedAt.slice(0, 10)}
                  </small>
                </th>
                <td data-label="Cause">{sample.causeLabel}</td>
                <td data-label="Outcome">
                  <span className={`repair-outcome is-${sample.outcomeTone}`}>{sample.outcomeLabel}</span>
                </td>
                <td data-label="Attempts">
                  {sample.rounds}r · {sample.attempts} att
                  {(sample.coldReplacements > 0 || sample.failedResumes > 0) && (
                    <small>{sample.coldReplacements} cold · {sample.failedResumes} failed resume</small>
                  )}
                </td>
                <td data-label="Duration">{sample.durationText}</td>
                <td data-label="Measured cost">
                  {sample.cost.measured ? (
                    sample.cost.label
                  ) : (
                    <span className="cost-badge">Unmeasured</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="quiet">No repair loops recorded in this window.</p>
      )}

      <p className="cost-foot quiet">
        Denominator includes resolved, in-progress, blocked, cancelled, and superseded loops · {vm.coverage.measuredLoops} measured / {vm.coverage.unmeasuredLoops} unmeasured · unmeasured work is never coerced to $0
      </p>
    </section>
  );
}
