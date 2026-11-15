import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readConfig } from "../packages/host/src/config.js";

test("the blackboard switch parses strictly and without a default", () => {
  const root = mkdtempSync(join(tmpdir(), "inf-blackboard-config-"));
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
    assert.deepEqual(parse({ blackboard: { tools: true } }).teams?.blackboard, { tools: true });
    assert.deepEqual(parse({ blackboard: {} }).teams?.blackboard, {});
    const without = parse({});
    assert.ok(without.teams);
    assert.equal("blackboard" in without.teams, false);
    assert.throws(() => parse({ blackboard: { tools: "yes" } }));
    assert.throws(() => parse({ blackboard: { contextReduction: true } }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
