import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bootId, hostProcesses, type CensusFinding, type HostProcesses } from "../packages/host/src/process-census.js";

/*
 * The account that runs the tests may own processes it cannot inspect: on Linux, a login session's service manager and
 * its SSH processes. The census reports each as `unreadable`, and a main check then never removes its copy
 * (docs/teams.md, "Main check", limits). Those processes ran before any test began, so no check of a test left them.
 * The list is taken once. A process of that kind that appears during the tests, such as a new SSH login to the same
 * account, is not in it, and the cases that wait for a copy to be removed then time out.
 */

/** The processes of this account that the census cannot inspect now, by pid and start token. */
export async function earlierProcesses(): Promise<Map<number, string>> {
  const earlier = new Map<number, string>();
  const look = await hostProcesses.census({ boot: bootId(), processes: [], sessions: [], groups: [] }, join(tmpdir(), `main-check-no-such-directory-${process.pid}`));
  if (!look.ok) return earlier;
  for (const finding of look.findings) {
    if (finding.reason !== "unreadable") continue;
    const start = await hostProcesses.start(finding.pid).catch(() => undefined);
    if (start !== undefined) earlier.set(finding.pid, start);
  }
  return earlier;
}

/** The host's census without `earlier` among the processes it could not inspect. Everything else is the real census. */
export function censusPast(earlier: Map<number, string>): HostProcesses {
  if (earlier.size === 0) return hostProcesses;
  const later = async (findings: CensusFinding[]) => {
    const kept: CensusFinding[] = [];
    for (const finding of findings) {
      const same = finding.reason === "unreadable" && earlier.has(finding.pid) && await hostProcesses.start(finding.pid).catch(() => undefined) === earlier.get(finding.pid);
      if (!same) kept.push(finding);
    }
    return kept;
  };
  return {
    ...hostProcesses,
    async census(witness, directory, prefix) {
      const first = await hostProcesses.census(witness, directory, prefix);
      if (!first.ok) return first;
      const kept = await later(first.findings);
      if (kept.length > 0 || kept.length === first.findings.length) return { ok: true, findings: kept };
      // The census stops after one look when it could not inspect a process. With only earlier processes in the way,
      // look once more, as the census does itself when its first look finds nothing.
      await delay(100);
      const second = await hostProcesses.census(witness, directory, prefix);
      return second.ok ? { ok: true, findings: await later(second.findings) } : second;
    },
  };
}
