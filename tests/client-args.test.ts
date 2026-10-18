import test from "node:test";
import assert from "node:assert/strict";
import { parseClientArgs } from "../packages/host/src/client.js";

test("codex defaults to cloud execution; --laptop is the explicit opt-in", () => {
  const cloud = parseClientArgs(["codex", "--model", "m", "Inspect"]);
  assert.equal(cloud.command, "codex");
  assert.equal(cloud.options["--laptop"], undefined);
  assert.equal(cloud.options["--local-ui"], undefined);
  assert.deepEqual(cloud.args, ["--model", "m", "Inspect"]);
  const laptop = parseClientArgs(["--laptop", "codex", "Inspect"]);
  assert.equal(laptop.options["--laptop"], true);
  assert.equal(laptop.options["--local-ui"], true, "laptop execution still requires the Codex native interface");
});

test("--cloud stays accepted as a no-op and conflicts with --laptop", () => {
  const parsed = parseClientArgs(["--cloud", "codex"]);
  assert.equal(parsed.options["--cloud"], true);
  assert.equal(parsed.options["--laptop"], undefined);
  assert.throws(() => parseClientArgs(["--cloud", "--laptop", "codex"]), /either cloud execution or --laptop/);
});

test("--laptop is Codex-only and --include needs --laptop", () => {
  assert.throws(() => parseClientArgs(["--laptop", "claude"]), /--laptop starts a Codex session/);
  assert.throws(() => parseClientArgs(["--include", "../shared", "codex"]), /--include applies to --laptop/);
  assert.deepEqual(parseClientArgs(["--include", "../shared", "--laptop", "codex"]).includes, ["../shared"]);
});

test("non-provider commands keep positionals and later options", () => {
  const parsed = parseClientArgs(["resume", "5ba58d55", "--takeover"]);
  assert.equal(parsed.command, "resume");
  assert.deepEqual(parsed.args, ["5ba58d55"]);
  assert.equal(parsed.options["--takeover"], true);
});

test("server administration commands keep their own options even when a provider name appears", () => {
  const parsed = parseClientArgs(["new", "--provider", "codex", "--title", "Task"]);
  assert.equal(parsed.command, "new");
  assert.deepEqual(parsed.args, []);
});

test("sync and pull commands parse their options", () => {
  const start = parseClientArgs(["sync", "--project", "example"]);
  assert.equal(start.command, "sync"); assert.equal(start.options["--project"], "example");
  const stop = parseClientArgs(["sync", "--stop"]);
  assert.equal(stop.options["--stop"], true);
  const apply = parseClientArgs(["sync", "--apply", "--force"]);
  assert.equal(apply.options["--apply"], true); assert.equal(apply.options["--force"], true);
  const pull = parseClientArgs(["pull", "example", "--output", "/tmp/x"]);
  assert.deepEqual(pull.args, ["example"]); assert.equal(pull.options["--output"], "/tmp/x");
  assert.throws(() => parseClientArgs(["--include", "../lib", "sync"]), /--include applies to --laptop/);
  assert.throws(() => parseClientArgs(["sync", "--include", "../lib"]), /--include applies to --laptop/, "a trailing --include is refused too");
  assert.throws(() => parseClientArgs(["sync", "--laptop"]), /--laptop starts a Codex session/);
});

test("sync accepts one action and no arguments; pull takes at most one project", () => {
  assert.throws(() => parseClientArgs(["sync", "--force"]), /--force applies to infinite sync --apply/);
  assert.throws(() => parseClientArgs(["sync", "--stop", "--status"]), /Choose one of --stop, --status, or --apply/);
  assert.throws(() => parseClientArgs(["sync", "--apply", "--stop"]), /Choose one of --stop, --status, or --apply/);
  assert.throws(() => parseClientArgs(["sync", "example"]), /infinite sync takes no arguments/);
  assert.throws(() => parseClientArgs(["pull", "a", "b"]), /infinite pull takes at most one project ID/);
  assert.deepEqual(parseClientArgs(["pull"]).args, []);
});

test("team review logs are a view flag and do not replace json", () => {
  const parsed = parseClientArgs(["team", "watch", "team-1", "--logs"]);
  assert.equal(parsed.command, "team");
  assert.deepEqual(parsed.args, ["watch", "team-1"]);
  assert.equal(parsed.options["--logs"], true);
  assert.throws(() => parseClientArgs(["team", "status", "team-1", "--logs", "--json"]), /either --logs or --json/);
  assert.throws(() => parseClientArgs(["list", "--logs"]), /--logs applies to infinite team/);
});
