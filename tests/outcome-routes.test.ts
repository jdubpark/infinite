import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { teamLineupSchema } from "../packages/host/src/team-types.js";
import { startHost, waitFor } from "./helpers.js";
import { fixture, mixedLineup } from "./team-fixture.js";

const coordinator = { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" };
const lineup = {
  coordinator,
  implementers: [{ id: "light", label: "Light", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  integrator: { ...coordinator, id: "integrator", label: "Integrator" },
  reviewer: { ...coordinator, id: "reviewer", label: "Reviewer" },
};

/** Client CLI against a started host, as the client command tests run it. The token is the given role's. */
function clientCli(host: { origin: string; tokens: Record<string, string> }, root: string, role: "owner" | "viewer" = "owner") {
  const clientFile = join(root, `client-${role}.json`);
  writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens[role], projectId: "rehearsal" }), { mode: 0o600 });
  const entry = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
  const exec = promisify(execFile);
  return (...args: string[]) => exec(entry[0]!, [...entry.slice(1), ...args]);
}

function outcomesCli(host: { origin: string; tokens: Record<string, string> }, root: string, role: "owner" | "viewer" = "owner") {
  const run = clientCli(host, root, role);
  return (...args: string[]) => run("usage", "outcomes", "new-epoch", ...args);
}

test("the owner advances a profile epoch", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "inf-outcome-routes-"));
  const host = await startHost({ config: { teams: { workspaceDir: join(root, "teams"), lineup } } });
  try {
    const requestId = randomUUID();
    const advance = (profileId: string, id: string, role: "owner" | "viewer" = "owner") =>
      host.fetchApi("/outcomes/epochs", role, { profileId, requestId: id });

    assert.equal((await advance("light", randomUUID(), "viewer")).status, 403);
    assert.equal((await advance("missing", randomUUID())).status, 404);

    const first = await advance("light", requestId);
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.body).sort(), ["effort", "epoch", "model", "profileId", "provider", "repeated", "since"]);
    assert.equal(first.body.profileId, "light");
    assert.equal(first.body.provider, "codex");
    assert.equal(first.body.model, "gpt-6-luna");
    assert.equal(first.body.effort, "high");
    assert.equal(first.body.epoch, 2);
    assert.equal(first.body.repeated, false);
    assert.equal(new Date(first.body.since).toISOString(), first.body.since);

    const repeated = await advance("light", requestId);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.epoch, 2, "a repeated request keeps its epoch");
    assert.equal(repeated.body.repeated, true);
    assert.equal(repeated.body.since, first.body.since);

    const next = await advance("light", randomUUID());
    assert.equal(next.body.epoch, 3, "a new request advances the epoch again");

    const other = await advance("coordinator", randomUUID());
    assert.equal(other.body.epoch, 2, "another profile starts from its own epoch");

    const conflict = await advance("coordinator", requestId);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "request-conflict");
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a profile id names one identity across the lineup, and a shared identity is accepted", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "inf-outcome-ambiguous-"));
  // "shared" names two identities in two slots. The lineup schema refuses that, so a valid config never reaches the
  // route's profile-ambiguous answer. "twin" names one identity in two slots, which is valid.
  const ambiguous = {
    coordinator: { ...coordinator, id: "shared" },
    implementers: [{ id: "shared", label: "Shared", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
    integrator: { ...coordinator, id: "twin", label: "Integrator" },
    reviewer: { ...coordinator, id: "twin", label: "Twin reviewer" },
  };
  assert.equal(teamLineupSchema.safeParse(ambiguous).success, false, "the schema refuses one id for two identities");
  const twins = { ...lineup, integrator: ambiguous.integrator, reviewer: ambiguous.reviewer };
  assert.equal(teamLineupSchema.safeParse(twins).success, true, "one identity under two slots is valid");
  const host = await startHost({ config: { teams: { workspaceDir: join(root, "teams"), lineup: twins } } });
  try {
    const accepted = await host.fetchApi("/outcomes/epochs", "owner", { profileId: "twin", requestId: randomUUID() });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.provider, "claude");
    assert.equal(accepted.body.model, "claude-opus-5-5");
    assert.equal(accepted.body.effort, "xhigh");
    assert.equal(accepted.body.epoch, 2);
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable store answers 503 and the status route still reports it", { timeout: 90000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "inf-outcome-unavailable-"));
  const host = await startHost({ config: { teams: { workspaceDir: join(root, "teams"), lineup } } });
  try {
    await host.stopApi();
    const location = join(host.config.stateDir, "evidence");
    rmSync(location, { recursive: true, force: true });
    writeFileSync(location, "not a directory");
    await host.start();

    const refused = await host.fetchApi("/outcomes/epochs", "owner", { profileId: "light", requestId: randomUUID() });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, "evidence-unavailable");

    const view = await host.fetchApi(`/outcomes/runs/${randomUUID()}`, "owner");
    assert.equal(view.status, 503);
    assert.equal(view.body.code, "evidence-unavailable");

    const status = await host.fetchApi("/evidence/status");
    assert.equal(status.status, 200);
    assert.equal(status.body.state, "unavailable");
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the new-epoch command prints the epoch", { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "inf-outcome-cli-"));
  const host = await startHost({ config: { teams: { workspaceDir: join(root, "teams"), lineup } } });
  try {
    const owner = outcomesCli(host, root);
    const printed = (await owner("--profile", "light")).stdout.trim();
    const lines = printed.split("\n");
    assert.equal(lines.length, 1, "one line");
    assert.match(lines[0]!, /^Profile light \(codex gpt-6-luna high\) is in epoch 2 since \d{4}-\d{2}-\d{2}T[\d:.]+Z\.$/);

    const json = JSON.parse((await owner("--profile", "light", "--json")).stdout);
    assert.equal(json.epoch, 3);
    assert.equal(json.repeated, false);

    await assert.rejects(owner("--profile", "missing"), (error: { stderr?: string }) => {
      assert.match(error.stderr ?? "", /No configured profile has ID "missing"/);
      return true;
    });

    const viewer = outcomesCli(host, root, "viewer");
    await assert.rejects(viewer("--profile", "light"), (error: { stderr?: string }) => {
      assert.match(error.stderr ?? "", /Advancing a profile epoch requires an owner device key\./);
      return true;
    });
  } finally {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("rows outlive a cancelled run", { timeout: 120000 }, async () => {
  const f = await fixture("live-limit", undefined, {}, { parallelism: 1 });
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const runId = created.body.id;
    await waitFor(() => Promise.resolve(existsSync(join(f.receipts, `${runId}.a-started`))), Boolean, 30000);
    const before = await f.get(runId);
    const cancelled = await f.host.fetchApi(`/teams/${runId}/cancel`, "owner", { requestId: randomUUID(), revision: before.revision });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const stopped = await waitFor(() => f.get(runId), run => run.status === "cancelled", 60000);
    assert.equal(stopped.status, "cancelled", JSON.stringify(stopped));
    // The run is cancelled before its implementer session has settled, so removal waits for that.
    const removed = await waitFor(() => f.host.fetchApi(`/teams/${runId}`, "owner", undefined, undefined, "DELETE"), response => response.status === 200, 60000);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    const view = await waitFor(() => f.host.fetchApi(`/outcomes/runs/${runId}`, "owner"), response => response.status === 200 && response.body.rows.some((row: { role: string }) => row.role === "implementer"), 30000);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    const implementer = view.body.rows.find((row: { role: string }) => row.role === "implementer");
    assert.equal(implementer.exclusion, "owner");
    assert.equal(implementer.disposition, "owner-stop");
    assert.notEqual(implementer.runDeletedAt, null);
    assert.notEqual(view.body.summary.runDeletedAt, null);
    // The cancel settled the run before the halt stopped the member, and the summary still counts the stop.
    assert.equal(view.body.summary.status, "cancelled");
    assert.equal(view.body.summary.payload.attempts["owner-stop"], 1, JSON.stringify(view.body.summary.payload.attempts));
    assert.equal(view.body.summary.payload.attempts.open, undefined);
  } finally { await f.close(); }
});

test("the outcomes command prints one line per row", { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "inf-outcome-run-cli-"));
  const f = await fixture();
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const run = await f.settled(created.body.id);
    assert.equal(run.status, "ready-for-review", JSON.stringify(run));
    const view = await waitFor(() => f.host.fetchApi(`/outcomes/runs/${run.id}`, "owner"), response => response.status === 200 && response.body.rows.length === 2, 30000);
    const memberId = view.body.rows[0].memberId as string;

    const owner = clientCli(f.host, root, "owner");
    const lines = (await owner("usage", "outcomes", "--run", run.id)).stdout.trim().split("\n");
    assert.ok(lines.some(line => line.includes(memberId) && line.includes("integrated=")), lines.join("\n"));

    const json = JSON.parse((await owner("usage", "outcomes", "--run", run.id, "--json")).stdout);
    assert.equal(json.rows.length, 2);

    await assert.rejects(owner("usage", "outcomes", "--run", randomUUID()), (error: { stderr?: string }) => {
      assert.match(error.stderr ?? "", /No outcome rows exist for run "/);
      return true;
    });
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a host with no events for a run rebuilds its rows at the next start", { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const run = await f.settled(created.body.id);
    assert.equal(run.status, "ready-for-review", JSON.stringify(run));
    // A host whose runs predate the ledger, or that lost its evidence database, holds a run's record and no
    // `run.created` for it. The record's last waiting events are sent again at the start, so the summary can be
    // made by an event first; the backfill then completes it.
    await f.host.stopApi();
    const database = evidenceDatabasePath(f.host.config.stateDir);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${database}${suffix}`, { force: true });
    await f.host.start();

    const view = await f.host.fetchApi(`/outcomes/runs/${run.id}`, "owner");
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.ok(view.body.summary.flags.includes("backfilled"), JSON.stringify(view.body.summary));
    assert.equal(view.body.summary.payload.projectId, run.projectId);
    assert.equal(view.body.summary.status, "ready-for-review");
    // Only an event sets the settle time, so an event made this summary first and the backfill completed it.
    assert.notEqual(view.body.summary.settledAt, null, JSON.stringify(view.body.summary));
    assert.notEqual(view.body.summary.createdAt, null);
    assert.equal(view.body.summary.flags.includes("gap"), false, "the record supplied the facts the flag stood for");
    assert.equal(view.body.rows.length, 2);
    for (const row of view.body.rows) {
      assert.ok(row.flags.includes("backfilled"), JSON.stringify(row));
      assert.deepEqual([row.integrated, row.accepted, row.firstPass, row.held], [1, 1, 1, null], JSON.stringify(row));
    }
    assert.deepEqual(view.body.members, [], "member results are not backfilled");
  } finally { await f.close(); }
});

test("display cells over a full run", { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const run = await f.settled(created.body.id);
    assert.equal(run.status, "ready-for-review", JSON.stringify(run));
    const view = await waitFor(() => f.host.fetchApi(`/outcomes/runs/${run.id}`, "owner"), response => response.status === 200 && response.body.rows.length === 2, 30000);
    const implementerRows = view.body.rows.filter((row: { role: string }) => row.role === "implementer").length;
    assert.equal(implementerRows, 2);

    const cells = await f.host.fetchApi("/outcomes?by=profile", "viewer");
    assert.equal(cells.status, 200, JSON.stringify(cells.body));
    assert.equal(cells.body.use, "display");
    assert.deepEqual(cells.body.query, { role: "implementer", by: ["profile"], sources: ["production"] });
    assert.equal(cells.body.unreadable, 0);
    assert.equal(cells.body.cells.reduce((sum: number, cell: { attempts: number }) => sum + cell.attempts, 0), implementerRows);
    for (const cell of cells.body.cells) {
      // This fixture's members have no effort, and a missing effort adds no key entry.
      assert.deepEqual(Object.keys(cell.key).sort(), ["epoch", "model", "profile", "provider"]);
      assert.deepEqual(cell.sources, ["production"]);
    }

    const legacy = await f.host.fetchApi("/outcomes?sources=legacy", "owner");
    assert.equal(legacy.status, 200);
    assert.deepEqual(legacy.body.cells, []);

    for (const query of ["by=owner", "by=profile,profile", "days=0", "role=reviewer"])
      assert.equal((await f.host.fetchApi(`/outcomes?${query}`, "owner")).status, 400, query);
  } finally { await f.close(); }
});

test("the outcomes command prints cells", { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "inf-outcome-cells-cli-"));
  const f = await fixture();
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const run = await f.settled(created.body.id);
    assert.equal(run.status, "ready-for-review", JSON.stringify(run));
    await waitFor(() => f.host.fetchApi(`/outcomes/runs/${run.id}`, "owner"), response => response.status === 200 && response.body.rows.length === 2, 30000);

    const owner = clientCli(f.host, root, "owner");
    const lines = (await owner("usage", "outcomes", "--by", "profile")).stdout.trim().split("\n");
    assert.ok(lines.length >= 1);
    for (const line of lines) assert.ok(line.includes("attempts"), line);

    const json = JSON.parse((await owner("usage", "outcomes", "--by", "profile", "--json")).stdout);
    assert.ok(Array.isArray(json.cells));
    assert.equal(json.use, "display");

    await assert.rejects(owner("usage", "outcomes", "--days", "0"), (error: { stderr?: string }) => {
      assert.match(error.stderr ?? "", /The host refused the outcome query\./);
      return true;
    });
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an advanced epoch retires a profile's scorecard row", { timeout: 180000 }, async () => {
  const lineup = structuredClone(mixedLineup);
  lineup.implementers = [lineup.implementers[0]!, { id: "deepseek-high", label: "DeepSeek implementer", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light", dataUse: "contributor" }];
  const f = await fixture("usage", lineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const settled = await f.settled(created.body.id);
    assert.equal(settled.status, "ready-for-review", JSON.stringify(settled));
    const profiles = (body: { rows: { profileId: string }[] }) => body.rows.map(row => row.profileId).sort();
    const before = await waitFor(() => f.host.fetchApi("/usage/models"), response => response.status === 200 && response.body.rows.length === 2, 30000);
    assert.deepEqual(profiles(before.body), ["deepseek-high", lineup.implementers[0]!.id].sort());

    // The owner says the backend behind this profile changed. No attempt has started under the new epoch, so the
    // old history must not stand as the profile's row.
    const advanced = await f.host.fetchApi("/outcomes/epochs", "owner", { profileId: "deepseek-high", requestId: randomUUID() });
    assert.equal(advanced.status, 200, JSON.stringify(advanced.body));
    assert.equal(advanced.body.epoch, 2);
    const after = await f.host.fetchApi("/usage/models");
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.deepEqual(profiles(after.body), [lineup.implementers[0]!.id]);
  } finally { await f.close(); }
});
