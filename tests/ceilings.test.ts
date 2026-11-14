import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { checkCeiling, type CeilingFs, type CeilingCheckInput, type CeilingLine } from "../packages/host/src/ceilings.js";

const SYSTEM = "/etc/claude-code/managed-settings.json";
const TEMPLATE = "/repo/deploy/ubuntu/ceilings/managed-settings.json";
const TEMPLATE_BYTES = new TextEncoder().encode('{"permissions":{"disableBypassPermissionsMode":"disable"}}\n');
const SHIPPED_HASH = createHash("sha256").update(TEMPLATE_BYTES).digest("hex");

// In-memory filesystem: paths map to uid, mode and bytes.
function fakeFs(files: Record<string, { uid?: number; mode?: number; bytes?: Uint8Array }>): CeilingFs {
  return {
    stat(path) {
      const entry = files[path];
      if (!entry) return undefined;
      return { uid: entry.uid ?? 0, mode: entry.mode ?? 0o644 };
    },
    read(path) {
      return files[path]?.bytes;
    },
  };
}

// Healthy installed state: root-owned file and parent, 0644/0755, bytes equal to the template.
function healthy(extra: Record<string, { uid?: number; mode?: number; bytes?: Uint8Array }> = {}) {
  return fakeFs({
    "/etc/claude-code": { mode: 0o755 },
    [SYSTEM]: { mode: 0o644, bytes: TEMPLATE_BYTES },
    [TEMPLATE]: { mode: 0o644, bytes: TEMPLATE_BYTES },
    ...extra,
  });
}

function run(overrides: Partial<CeilingCheckInput> = {}): CeilingLine[] {
  return checkCeiling({
    provider: "claude",
    systemPath: SYSTEM,
    templatePath: TEMPLATE,
    launchArgs: ["--output-format", "stream-json", "--permission-mode", "dontAsk"],
    fs: healthy(),
    ...overrides,
  });
}

const byCheck = (lines: CeilingLine[], check: CeilingLine["check"]) => {
  const found = lines.find((line) => line.check === check);
  assert.ok(found, `no ${check} line`);
  return found;
};

test("present, root-owned, matching template and clean profile are all ok", () => {
  const lines = run();
  assert.deepEqual(
    lines.map((line) => [line.check, line.status]),
    [
      ["present", "ok"],
      ["writable", "ok"],
      ["hash", "ok"],
      ["profile", "ok"],
    ],
  );
  assert.match(byCheck(lines, "hash").detail, new RegExp(SHIPPED_HASH));
});

test("a changed file reports changed with both hashes", () => {
  const lines = run({ fs: healthy({ [SYSTEM]: { mode: 0o644, bytes: new TextEncoder().encode("{}") } }) });
  const hash = byCheck(lines, "hash");
  assert.equal(hash.status, "changed");
  assert.match(hash.detail, new RegExp(SHIPPED_HASH));
});

test("a file writable by group reports writable", () => {
  const lines = run({ fs: healthy({ [SYSTEM]: { mode: 0o664, bytes: TEMPLATE_BYTES } }) });
  const writable = byCheck(lines, "writable");
  assert.equal(writable.status, "writable");
  assert.match(writable.detail, /group- or world-writable \(664\)/);
});

test("a file owned by a non-root user reports writable", () => {
  const lines = run({ fs: healthy({ [SYSTEM]: { uid: 501, mode: 0o644, bytes: TEMPLATE_BYTES } }) });
  assert.equal(byCheck(lines, "writable").status, "writable");
});

test("a world-writable parent directory reports writable even when the file is safe", () => {
  const lines = run({
    fs: healthy({ "/etc/claude-code": { mode: 0o777 } }),
  });
  const writable = byCheck(lines, "writable");
  assert.equal(writable.status, "writable");
  assert.match(writable.detail, /\/etc\/claude-code is group- or world-writable/);
  assert.equal(byCheck(lines, "hash").status, "ok");
});

test("a configured bypass-permissions profile conflicts with the ceiling", () => {
  const lines = run({ launchArgs: ["--dangerously-skip-permissions"] });
  const profile = byCheck(lines, "profile");
  assert.equal(profile.status, "conflict");
  assert.match(profile.detail, /--dangerously-skip-permissions/);
});

test("--permission-mode bypassPermissions in appServerArgs conflicts, dontAsk does not", () => {
  assert.equal(byCheck(run({ launchArgs: ["--permission-mode", "bypassPermissions"] }), "profile").status, "conflict");
  assert.equal(byCheck(run({ launchArgs: ["--permission-mode", "dontAsk"] }), "profile").status, "ok");
});

test("codex full-access sandbox overrides conflict, read-only and workspace-write do not", () => {
  const codex = { provider: "codex" as const, systemPath: "/etc/codex/requirements.toml", templatePath: TEMPLATE };
  const codexFs = fakeFs({
    "/etc/codex": { mode: 0o755 },
    "/etc/codex/requirements.toml": { mode: 0o644, bytes: TEMPLATE_BYTES },
    [TEMPLATE]: { mode: 0o644, bytes: TEMPLATE_BYTES },
  });
  const profileOf = (launchArgs: string[]) =>
    byCheck(checkCeiling({ ...codex, launchArgs, fs: codexFs }), "profile");

  assert.equal(profileOf(["-c", 'sandbox_mode="danger-full-access"']).status, "conflict");
  assert.equal(profileOf(["--sandbox", "danger-full-access"]).status, "conflict");
  assert.equal(profileOf(["--dangerously-bypass-approvals-and-sandbox"]).status, "conflict");
  assert.equal(profileOf(["-c", 'sandbox_mode="workspace-write"']).status, "ok");
  assert.equal(profileOf(["--sandbox", "read-only"]).status, "ok");
});

test("a missing ceiling is a warning line, not a throw, and the profile check still runs", () => {
  const lines = run({ fs: fakeFs({ "/etc/claude-code": { mode: 0o755 }, [TEMPLATE]: { bytes: TEMPLATE_BYTES } }) });
  assert.deepEqual(
    lines.map((line) => [line.check, line.status]),
    [
      ["present", "missing"],
      ["profile", "ok"],
    ],
  );
  assert.match(byCheck(lines, "present").detail, /install-ceilings\.sh/);
});

test("the shipped Claude template parses and sets only the keys the ceiling is meant to set", () => {
  const shipped = JSON.parse(readFileSync(resolve("deploy/ubuntu/ceilings/managed-settings.json"), "utf8")) as Record<string, unknown>;
  const permissions = shipped.permissions as Record<string, unknown>;
  assert.equal(permissions.disableBypassPermissionsMode, "disable");
  assert.equal(permissions.disableAutoMode, "disable");
  assert.ok(Array.isArray(permissions.deny) && permissions.deny.length > 0);
  // Deliberately not set: these would break the host's own hooks, MCP, and launch flags.
  for (const key of ["allowManagedHooksOnly", "allowManagedPermissionRulesOnly", "allowManagedMcpServersOnly", "disableSideloadFlags"]) {
    assert.equal(key in shipped, false, `${key} must not be set by the default ceiling`);
  }
});
