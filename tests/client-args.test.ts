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
