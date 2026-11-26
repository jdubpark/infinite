import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { hashToken } from "../packages/host/src/config.js";

function runDoctorWithHome(setupHome: (homeDir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "infinite-doctor-settings-"));
  const homeDir = join(root, "home");
  const stateDir = join(root, "state");
  const runDir = join(root, "run");
  const projectDir = join(root, "project");
  const keyFile = join(root, "vault.key");
  const configFile = join(root, "config.json");
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  writeFileSync(
    configFile,
    JSON.stringify({
      machine: { id: randomUUID(), label: "Doctor fixture" },
      deployment: { mode: "single-tenant" },
      port: 4780,
      origin: "http://127.0.0.1:4780",
      stateDir,
      runDir,
      keyFile,
      environment: "local",
      enableDemo: false,
      maxSessions: 4,
      tokens: [{ id: randomUUID(), label: "owner", role: "owner", hash: hashToken(randomBytes(32).toString("base64url")) }],
      projects: [{ id: "workspace", name: "Workspace", path: projectDir }],
      agents: {},
    }),
    { mode: 0o600 },
  );
  try {
    setupHome(homeDir);
    return spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("packages/host/src/cli.ts"), "doctor", "--config", configFile],
      { encoding: "utf8", env: { ...process.env, HOME: homeDir } },
    );
  } finally {
    try {
      chmodSync(join(homeDir, ".claude", "settings.json"), 0o600);
    } catch {}
    try {
      chmodSync(join(homeDir, ".claude"), 0o700);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

test("infinite doctor stays quiet when ~/.claude/settings.json is absent or valid without allowedHttpHookUrls", () => {
  const absentDir = runDoctorWithHome(() => {});
  assert.equal(absentDir.status, 0, absentDir.stderr);
  assert.doesNotMatch(absentDir.stdout, /settings\.json|allowedHttpHookUrls/);

  const absentFile = runDoctorWithHome(home => {
    mkdirSync(join(home, ".claude"), { recursive: true });
  });
  assert.equal(absentFile.status, 0, absentFile.stderr);
  assert.doesNotMatch(absentFile.stdout, /settings\.json|allowedHttpHookUrls/);

  const valid = runDoctorWithHome(home => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.doesNotMatch(valid.stdout, /settings\.json|allowedHttpHookUrls/);
});

test("infinite doctor preserves the allowedHttpHookUrls warning when defined", () => {
  const result = runDoctorWithHome(home => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ allowedHttpHookUrls: ["https://example.invalid/*"] }),
    );
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARNING: ~\/\.claude\/settings\.json defines allowedHttpHookUrls; add http:\/\/127\.0\.0\.1:\*\/hook\/claude/);
});

test("infinite doctor emits a bounded warning when ~/.claude/settings.json has invalid or non-object JSON without leaking file contents", () => {
  const secret = `SECRET_TOKEN_${"X".repeat(200)}`;
  const invalid = runDoctorWithHome(home => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), `{"apiKey":"${secret}", broken`);
  });
  assert.equal(invalid.status, 0, invalid.stderr);
  const invalidLine = invalid.stdout.split("\n").find(line => line.includes("settings.json"));
  assert.ok(invalidLine, invalid.stdout);
  assert.match(invalidLine, /^WARNING: ~\/\.claude\/settings\.json contains invalid JSON; allowedHttpHookUrls could not be verified\.$/);
  assert.ok(!invalid.stdout.includes(secret));
  assert.ok(!invalid.stderr.includes(secret));

  for (const payload of ["null", JSON.stringify([secret])]) {
    const nonObject = runDoctorWithHome(home => {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), payload);
    });
    assert.equal(nonObject.status, 0, nonObject.stderr);
    const line = nonObject.stdout.split("\n").find(entry => entry.includes("settings.json"));
    assert.ok(line, `${payload}: ${nonObject.stdout}`);
    assert.match(line, /^WARNING: ~\/\.claude\/settings\.json does not contain a JSON object; allowedHttpHookUrls could not be verified\.$/);
    assert.ok(!nonObject.stdout.includes(secret));
    assert.ok(!nonObject.stderr.includes(secret));
  }
});

test("infinite doctor emits a bounded warning when ~/.claude/settings.json exists but cannot be read", () => {
  const directoryCase = runDoctorWithHome(home => {
    mkdirSync(join(home, ".claude", "settings.json"), { recursive: true });
  });
  assert.equal(directoryCase.status, 0, directoryCase.stderr);
  const dirLine = directoryCase.stdout.split("\n").find(line => line.includes("settings.json"));
  assert.ok(dirLine, directoryCase.stdout);
  assert.match(dirLine, /^WARNING: ~\/\.claude\/settings\.json could not be read \(EISDIR\); allowedHttpHookUrls could not be verified\.$/);

  const danglingLink = runDoctorWithHome(home => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync(join(home, "does-not-exist.json"), join(home, ".claude", "settings.json"));
  });
  assert.equal(danglingLink.status, 0, danglingLink.stderr);
  const linkLine = danglingLink.stdout.split("\n").find(line => line.includes("settings.json"));
  assert.ok(linkLine, danglingLink.stdout);
  assert.match(linkLine, /^WARNING: ~\/\.claude\/settings\.json could not be read \(ENOENT\); allowedHttpHookUrls could not be verified\.$/);

  if (process.getuid?.() !== 0) {
    const unreadableFile = runDoctorWithHome(home => {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const file = join(home, ".claude", "settings.json");
      writeFileSync(file, "{}");
      chmodSync(file, 0o000);
    });
    assert.equal(unreadableFile.status, 0, unreadableFile.stderr);
    const permLine = unreadableFile.stdout.split("\n").find(line => line.includes("settings.json"));
    assert.ok(permLine, unreadableFile.stdout);
    assert.match(permLine, /^WARNING: ~\/\.claude\/settings\.json could not be read \(EACCES\); allowedHttpHookUrls could not be verified\.$/);
  }
});
