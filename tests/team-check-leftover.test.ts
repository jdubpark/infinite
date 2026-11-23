import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkTimeoutReason, commandLeftoverEvent } from "../packages/host/src/teams.js";
import { fixture } from "./team-fixture.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// INF-393: a configured check ends with its leader. The second check of this scenario exits 0 at once and leaves a
// process in its group that holds its output for a minute. With a three-second check limit, a check that waited for
// that process would run into the limit and block the run; here it passes by its exit code about a second later.
test("a check whose leader exits 0 while a process it left holds the output passes, and the process is neither waited for nor stopped", {
  timeout: 120_000, skip: process.platform === "win32" && "process groups are POSIX",
}, async () => {
  const f = await fixture("check-leftover", undefined, { teams: { checkMinutes: 0.05 } });
  const pidsFile = join(f.receipts, "check-leftover.pids");
  const leftovers = () => existsSync(pidsFile) ? readFileSync(pidsFile, "utf8").split("\n").filter(Boolean).map(Number) : [];
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const settled = await f.settled(created.body.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify({ status: settled.status, reason: settled.reason }));
    assert.notEqual(settled.reason, checkTimeoutReason);
    const leaving = settled.checks.filter(check => check.command.args?.includes("--leave-check"));
    assert.ok(leaving.length >= 1, "the leaving check ran");
    assert.ok(leaving.every(check => check.status === "passed" && check.exitCode === 0), JSON.stringify(leaving.map(check => [check.status, check.exitCode])));
    assert.ok(leaving.every(check => check.output.includes("The check passed and left a helper running.")), "the output read before the drain is kept");
    const notes = settled.events.filter(event => event.text === commandLeftoverEvent);
    assert.equal(notes.length, leaving.length, "one note per check that left a process holding its output");
    const pids = leftovers();
    assert.equal(pids.length, leaving.length);
    assert.ok(pids.every(alive), "every process a check left still runs after the run settled");
  } finally {
    for (const pid of leftovers()) if (Number.isSafeInteger(pid) && pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
    await f.close();
  }
});
