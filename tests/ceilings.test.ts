import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { checkCeiling, forbiddenLaunchFlags, nodeCeilingFs, type CeilingFileKind, type CeilingFs, type CeilingCheckInput, type CeilingLine } from "../packages/host/src/ceilings.js";

const SYSTEM = "/etc/claude-code/managed-settings.json";
const TEMPLATE = "/repo/deploy/ubuntu/ceilings/managed-settings.json";
const TEMPLATE_BYTES = new TextEncoder().encode('{"permissions":{"disableBypassPermissionsMode":"disable"}}\n');
const SHIPPED_HASH = createHash("sha256").update(TEMPLATE_BYTES).digest("hex");

type Entry = { uid?: number; mode?: number; bytes?: Uint8Array; kind?: CeilingFileKind };

function fakeFs(given: Record<string, Entry>): CeilingFs {
  const files: Record<string, Entry> = { "/": { mode: 0o755 }, "/etc": { mode: 0o755 }, ...given };
  return {
    stat(path) {
      const entry = files[path];
      if (!entry) return undefined;
      return { uid: entry.uid ?? 0, mode: entry.mode ?? 0o644, kind: entry.kind ?? (entry.bytes ? "file" : "directory") };
    },
    read(path) {
      return files[path]?.bytes;
    },
  };
}

function healthy(extra: Record<string, Entry> = {}) {
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
  assert.equal(byCheck(lines, "hash").status, "writable");
});

test("a ceiling that is a symbolic link reports writable, even when its target matches the template", () => {
  const lines = run({ fs: healthy({ [SYSTEM]: { kind: "symlink", mode: 0o777, bytes: TEMPLATE_BYTES } }) });
  const writable = byCheck(lines, "writable");
  assert.equal(writable.status, "writable");
  assert.match(writable.detail, /symbolic link/);
});

test("an entry that is not a regular file is reported without being opened", () => {
  const base = healthy({ [SYSTEM]: { kind: "other", mode: 0o644 } });
  const fs: CeilingFs = { stat: base.stat, read: (path) => { assert.notEqual(path, SYSTEM, "the ceiling path must not be read"); return base.read(path); } };
  const lines = run({ fs });
  assert.equal(byCheck(lines, "writable").status, "writable");
  assert.equal(byCheck(lines, "hash").status, "writable");
  assert.match(byCheck(lines, "hash").detail, /not read/);
  assert.equal(byCheck(lines, "profile").status, "ok");
});

test("the ceiling is not read while any placement check fails, even when the file itself is safe", () => {
  const base = healthy({ "/etc/claude-code": { mode: 0o777 } });
  const reads: string[] = [];
  const fs: CeilingFs = { stat: base.stat, read: (path) => { reads.push(path); return base.read(path); } };
  const lines = run({ fs });
  assert.equal(reads.includes(SYSTEM), false, "the ceiling path was read");
  assert.equal(byCheck(lines, "hash").status, "writable");
  assert.match(byCheck(lines, "hash").detail, /not read/);
});

test("the real reader does not follow a symbolic link and returns only regular files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ceilings-read-"));
  try {
    const target = join(dir, "target");
    writeFileSync(target, "ceiling");
    symlinkSync(target, join(dir, "link"));
    assert.equal(nodeCeilingFs.read(join(dir, "link")), undefined, "a link was followed");
    assert.equal(new TextDecoder().decode(nodeCeilingFs.read(target)), "ceiling");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real reader returns for a named pipe instead of waiting for a writer", () => {
  const dir = mkdtempSync(join(tmpdir(), "ceilings-fifo-"));
  try {
    const pipe = join(dir, "pipe");
    execFileSync("mkfifo", [pipe]);
    const probe = "import(process.env.CEILINGS_MODULE).then((m) => process.stdout.write(String(m.nodeCeilingFs.read(process.env.CEILINGS_PIPE) === undefined)))";
    const result = spawnSync(process.execPath, ["--import", "tsx", "-e", probe], {
      env: { ...process.env, CEILINGS_MODULE: pathToFileURL(resolve("packages/host/src/ceilings.ts")).href, CEILINGS_PIPE: pipe },
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.error, undefined, "the reader blocked on the pipe");
    assert.equal(result.stdout, "true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a directory higher up that another account can change reports writable", () => {
  assert.match(byCheck(run({ fs: healthy({ "/etc": { uid: 1001, mode: 0o755 } }) }), "writable").detail, /\/etc is owned by uid 1001/);
  assert.match(byCheck(run({ fs: healthy({ "/etc/claude-code": { kind: "symlink", mode: 0o777 } }) }), "writable").detail, /\/etc\/claude-code is a symbolic link/);
});

test("launch flags the ceilings turn off are found in each spelling, and look-alikes are not", () => {
  for (const args of [["--permission-mode", "auto"], ["--permission-mode=auto"], ["--permission-mode=bypassPermissions"]])
    assert.equal(forbiddenLaunchFlags("claude", args).length, 1, args.join(" "));
  for (const value of ['"""danger-full-access"""', "'''danger-full-access'''", '"\\u0064anger-full-access"', '"danger\\u002Dfull-access"'])
    assert.equal(forbiddenLaunchFlags("codex", ["--config", `sandbox_mode=${value}`]).length, 1, value);
  for (const args of [["-c", "sandbox_mode='danger-full-access'"], ["--config", "sandbox_mode = \"danger-full-access\""], ["--config=sandbox_mode=danger-full-access"], ["--sandbox=danger-full-access"], ["-s", "danger-full-access"]])
    assert.equal(forbiddenLaunchFlags("codex", args).length, 1, args.join(" "));
  assert.deepEqual(forbiddenLaunchFlags("codex", ["-c", 'notes="sandbox_mode=danger-full-access"', "--sandbox", "workspace-write"]), []);
  assert.deepEqual(forbiddenLaunchFlags("claude", ["--permission-mode", "dontAsk", "--append-system-prompt", "never use --permission-mode auto"]), []);
});

test("the hidden Codex alias --yolo is checked, as the CLI accepts it", () => {
  assert.deepEqual(forbiddenLaunchFlags("codex", ["--yolo"]), ["--yolo"]);
});

test("the Claude flag --enable-auto-mode is checked", () => {
  assert.deepEqual(forbiddenLaunchFlags("claude", ["--enable-auto-mode"]), ["--enable-auto-mode"]);
});

test("codex sandbox values are reported unless they read as exactly read-only or workspace-write", () => {
  assert.equal(forbiddenLaunchFlags("codex", ["-c", 'sandbox_mode="""danger-\\\n full-access"""']).length, 1);
  assert.equal(forbiddenLaunchFlags("codex", ["-sdanger-full-access"]).length, 1);
  assert.equal(forbiddenLaunchFlags("codex", ['-csandbox_mode="danger-full-access"']).length, 1);
  assert.equal(forbiddenLaunchFlags("codex", ["--sandbox=bogus"]).length, 1);
  assert.equal(forbiddenLaunchFlags("codex", ['-c=sandbox_mode="danger-full-access"']).length, 1);
  assert.equal(forbiddenLaunchFlags("codex", ["-s=danger-full-access"]).length, 1);
  assert.equal(forbiddenLaunchFlags("codex", ["-c", '"sandbox_mode"="danger-full-access"']).length, 1);
  assert.equal(forbiddenLaunchFlags("codex", ["-c", 'sandbox_mode="read-only" # note']).length, 1);
  assert.deepEqual(forbiddenLaunchFlags("codex", ["-sworkspace-write", "-c", "sandbox_mode='read-only'", '--config=sandbox_mode="workspace-write"']), []);
  assert.deepEqual(forbiddenLaunchFlags("codex", ["-s=workspace-write", "-c=sandbox_mode=read-only", "-c=model=gpt"]), []);
});

test("a codex permission-profile selection is reported unless it is a built-in profile the ceiling allows", () => {
  assert.deepEqual(forbiddenLaunchFlags("codex", ["-c", 'default_permissions=":danger-full-access"']), ['-c default_permissions=":danger-full-access"']);
  assert.equal(forbiddenLaunchFlags("codex", ["--config=default_permissions=wide"]).length, 1);
  assert.deepEqual(forbiddenLaunchFlags("codex", ["-c", 'default_permissions=":workspace"', "-c=default_permissions=':read-only'"]), []);
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
  for (const key of ["allowManagedHooksOnly", "allowManagedPermissionRulesOnly", "allowManagedMcpServersOnly", "disableSideloadFlags"]) {
    assert.equal(key in shipped, false, `${key} must not be set by the default ceiling`);
  }
});
