import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { outcomeSettingsSchema, readConfig } from "../packages/host/src/config.js";

test("outcome settings parse without defaults", () => {
  assert.deepEqual(outcomeSettingsSchema.parse({}), {});
  assert.equal(outcomeSettingsSchema.safeParse({ holdDays: 0 }).success, false);
  assert.equal(outcomeSettingsSchema.safeParse({ holdDays: 366 }).success, false);
  assert.equal(outcomeSettingsSchema.safeParse({ retentionDays: 29 }).success, false);
  assert.equal(outcomeSettingsSchema.safeParse({ unknown: 1 }).success, false);
  assert.deepEqual(outcomeSettingsSchema.parse({ holdDays: 14, retentionDays: 365 }), { holdDays: 14, retentionDays: 365 });

  const root = mkdtempSync(join(tmpdir(), "inf-outcome-config-"));
  try {
    const keyFile = join(root, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    mkdirSync(join(root, "project"));
    const base = {
      port: 0, origin: "http://127.0.0.1:4780", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile,
      environment: "local", tokens: [{ id: "o", label: "o", role: "owner", hash: "a".repeat(64) }],
      projects: [{ id: "p", name: "P", path: join(root, "project") }],
    };
    const parse = (teams?: object) => {
      writeFileSync(join(root, "config.json"), JSON.stringify(teams === undefined ? base : { ...base, teams: { workspaceDir: join(root, "workspace"), ...teams } }));
      return readConfig(join(root, "config.json")).config;
    };
    assert.equal(parse({ outcomes: { holdDays: 14 } }).teams?.outcomes?.holdDays, 14);
    const without = parse({});
    assert.ok(without.teams);
    assert.equal("outcomes" in without.teams, false);
    assert.equal(parse().teams, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
