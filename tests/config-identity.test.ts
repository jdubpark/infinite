import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configId,
  guidanceDigest,
  memberConfiguration,
  parseGuidanceTree,
  profileIdentityKey,
  profileKeyOf,
  promptVersion,
  readGuidanceDigest,
  renderedPrompts,
  type ConfigComponents,
} from "../packages/host/src/config-identity.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";

const HEX64 = /^[0-9a-f]{64}$/;

function components(overrides: Partial<ConfigComponents> = {}): ConfigComponents {
  return {
    profile: { provider: "opencode", model: "vendor/model-a", effort: "high" },
    promptVersion: "a".repeat(64),
    guidance: "b".repeat(64),
    knowledge: "none",
    routing: "off",
    shape: "team",
    ...overrides,
  };
}

test("a configId covers all six components", () => {
  const base = configId(components());
  assert.match(base, HEX64);
  assert.equal(configId(components()), base);
  // Key order of the input does not change the digest.
  const reordered = components();
  assert.equal(configId({ shape: reordered.shape, routing: reordered.routing, knowledge: reordered.knowledge, guidance: reordered.guidance, promptVersion: reordered.promptVersion, profile: { effort: "high", model: "vendor/model-a", provider: "opencode" } }), base);
  const changed = [
    components({ profile: { provider: "opencode", model: "vendor/model-b", effort: "high" } }),
    components({ profile: { provider: "opencode", model: "vendor/model-a", effort: "low" } }),
    components({ promptVersion: "c".repeat(64) }),
    components({ guidance: "d".repeat(64) }),
    components({ routing: "x" as "off" }),
    components({ shape: "trial" }),
  ].map(configId);
  for (const id of changed) assert.notEqual(id, base);
  assert.equal(new Set(changed).size, changed.length);
});

test("a profile key leaves out the id and the label", () => {
  const key = profileIdentityKey({ provider: "claude", model: "m", effort: "high" });
  assert.match(key, HEX64);
  assert.notEqual(profileIdentityKey({ provider: "claude", model: "m", effort: null }), key);
  assert.equal(profileIdentityKey({ provider: "claude", model: "m", effort: "high" }), key);
});

test("a profile id names one identity, none, or an ambiguous one", () => {
  const first = { id: "shared", label: "First", provider: "claude", model: "model-a", effort: "high" } as TeamModelProfile;
  const twin = { ...first, label: "Twin" } as TeamModelProfile;
  const other = { id: "shared", label: "Other", provider: "codex", model: "model-b", effort: "high" } as TeamModelProfile;
  assert.deepEqual(profileKeyOf([first, twin], "shared"), { provider: "claude", model: "model-a", effort: "high" });
  // The lineup schema refuses this lineup. The lookup still fails closed if one ever reaches it.
  assert.equal(profileKeyOf([first, other], "shared"), "ambiguous");
  assert.equal(profileKeyOf([first], "missing"), undefined);
  assert.equal(profileKeyOf([], "shared"), undefined);
});

test("the prompt version is stable per role and provider", () => {
  const first = promptVersion("implementer", "claude", undefined, true);
  assert.match(first, HEX64);
  assert.equal(promptVersion("implementer", "claude", undefined, true), first);
  assert.notEqual(promptVersion("reviewer", "claude", undefined, true), first);
  assert.notEqual(promptVersion("implementer", "codex", undefined, true), first);
});

test("the report command is not part of the prompt version", () => {
  // A provider without a report tool is told the reporter's path, which changes with every install directory.
  const profile = { id: "light", label: "Light", provider: "opencode", model: "vendor/model-a", variant: "high" } as unknown as TeamModelProfile;
  const rendered = renderedPrompts("implementer", "opencode", profile, true);
  assert.ok(rendered.length > 0);
  for (const text of rendered) {
    assert.equal(text.includes(process.execPath), false, "no Node path");
    assert.ok(text.includes("<report-command>"), "the command is a placeholder");
  }
  assert.match(promptVersion("implementer", "opencode", profile, true), HEX64);
});

test("the prompt version follows every profile field the prompt prints", () => {
  const worker = { id: "deep", label: "Deep worker", provider: "claude", model: "model-x", effort: "high" } as TeamModelProfile;
  const escalation = { ...worker, label: "Deep escalation" } as TeamModelProfile;
  // The second profile is asked first: a cache keyed by less than the profile would give it the first one's version.
  const escalationVersion = promptVersion("implementer", "claude", escalation, true);
  const workerVersion = promptVersion("implementer", "claude", worker, true);
  assert.notEqual(workerVersion, escalationVersion);
  assert.equal(promptVersion("implementer", "claude", { ...worker }, true), workerVersion, "an equal profile object gives one version");
  assert.equal(promptVersion("implementer", "claude", escalation, true), escalationVersion);
});

test("the guidance parser keeps guidance entries only", () => {
  const entries: [string, string, string][] = [
    ["100644", "AGENTS.md", "O1"],
    ["100755", "packages/host/CLAUDE.md", "O2"],
    ["100644", "docs/agents.md", "O3"],
    ["160000", "vendor/AGENTS.md", "O4"],
    ["100644", "src/MY-AGENTS.md", "O5"],
    ["120000", "a/CLAUDE.md", "O6"],
    // Git quotes a path that holds a non-ASCII byte, so the output stays ASCII.
    ["100644", '"d\\303\\251/AGENTS.md"', "O8"],
  ];
  const line = (mode: string, path: string, object: string, status = "A") => `:000000 ${mode} ${"0".repeat(40)} ${object} ${status}\t${path}\n`;
  const stdout = entries.map(([mode, path, object]) => line(mode, path, object)).join("") + line("100644", "AGENTS.md", "O7", "M");
  assert.deepEqual(parseGuidanceTree(stdout), [
    { path: '"d\\303\\251/AGENTS.md"', object: "O8" },
    { path: "AGENTS.md", object: "O1" },
    { path: "a/CLAUDE.md", object: "O6" },
    { path: "packages/host/CLAUDE.md", object: "O2" },
  ]);
  assert.deepEqual(parseGuidanceTree(""), []);
  assert.deepEqual(parseGuidanceTree("not a record\tAGENTS.md\n"), []);
});

test("the guidance digest is order-free and bound to content", () => {
  const a = { path: "AGENTS.md", object: "O1" };
  const b = { path: "CLAUDE.md", object: "O2" };
  const digest = guidanceDigest([a, b]);
  assert.match(digest, HEX64);
  assert.equal(guidanceDigest([b, a]), digest);
  assert.notEqual(guidanceDigest([a, { path: "CLAUDE.md", object: "O3" }]), digest);
  const empty = guidanceDigest([]);
  assert.match(empty, HEX64);
  assert.notEqual(empty, guidanceDigest([a]));
});

const GIT_ARGS = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

function temporaryRepository(objectFormat?: "sha256"): { dir: string; git: (args: string[]) => string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "config-identity-"));
  const git = (args: string[]) => execFileSync("git", [...GIT_ARGS, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try { git(["init", "-q", "--template=", ...(objectFormat ? [`--object-format=${objectFormat}`] : [])]); }
  catch (error) { cleanup(); throw error; }
  return { dir, git, cleanup };
}

test("a large repository still has a guidance digest", async () => {
  const repo = temporaryRepository();
  try {
    const files = Array.from({ length: 1500 }, (_, index) => `src/module-${String(index).padStart(4, "0")}/file-with-a-long-name.ts`);
    for (const file of files) {
      mkdirSync(join(repo.dir, file, ".."), { recursive: true });
      writeFileSync(join(repo.dir, file), `export const value = ${files.indexOf(file)};\n`);
    }
    writeFileSync(join(repo.dir, "AGENTS.md"), "root guidance\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-q", "-m", "large"]);
    const listing = execFileSync("git", ["ls-tree", "-r", "-z", "HEAD"], { cwd: repo.dir });
    assert.ok(listing.length > 65536, `the whole-tree listing must exceed the output cap, was ${listing.length} bytes`);

    const commit = repo.git(["rev-parse", "HEAD"]);
    const digest = await readGuidanceDigest(repo.dir, commit, undefined, new AbortController().signal);
    assert.equal(digest, guidanceDigest([{ path: "AGENTS.md", object: repo.git(["rev-parse", "HEAD:AGENTS.md"]) }]));
  } finally {
    repo.cleanup();
  }
}, { timeout: 120_000 });

test("no guidance file gives the empty-list digest", async () => {
  const repo = temporaryRepository();
  try {
    writeFileSync(join(repo.dir, "README.md"), "no guidance here\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-q", "-m", "plain"]);
    const digest = await readGuidanceDigest(repo.dir, repo.git(["rev-parse", "HEAD"]), undefined, new AbortController().signal);
    assert.equal(digest, guidanceDigest([]));
  } finally {
    repo.cleanup();
  }
});

test("an empty file and a symbolic link count", async () => {
  const repo = temporaryRepository();
  try {
    writeFileSync(join(repo.dir, "AGENTS.md"), "");
    mkdirSync(join(repo.dir, "a"));
    symlinkSync("../AGENTS.md", join(repo.dir, "a", "CLAUDE.md"));
    repo.git(["add", "."]);
    repo.git(["commit", "-q", "-m", "empty and link"]);
    const digest = await readGuidanceDigest(repo.dir, repo.git(["rev-parse", "HEAD"]), undefined, new AbortController().signal);
    assert.equal(digest, guidanceDigest([
      { path: "AGENTS.md", object: repo.git(["rev-parse", "HEAD:AGENTS.md"]) },
      { path: "a/CLAUDE.md", object: repo.git(["rev-parse", "HEAD:a/CLAUDE.md"]) },
    ]));
  } finally {
    repo.cleanup();
  }
});

test("a SHA-256 repository reads its guidance", async t => {
  let repo: ReturnType<typeof temporaryRepository>;
  try { repo = temporaryRepository("sha256"); }
  catch { t.skip("this Git cannot create a SHA-256 repository"); return; }
  try {
    writeFileSync(join(repo.dir, "AGENTS.md"), "root guidance\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-q", "-m", "sha256"]);
    const commit = repo.git(["rev-parse", "HEAD"]);
    assert.equal(commit.length, 64);
    const digest = await readGuidanceDigest(repo.dir, commit, undefined, new AbortController().signal);
    assert.equal(digest, guidanceDigest([{ path: "AGENTS.md", object: repo.git(["rev-parse", "HEAD:AGENTS.md"]) }]));
  } finally {
    repo.cleanup();
  }
});

test("a path with a non-ASCII character reads the same every time", async () => {
  const repo = temporaryRepository();
  try {
    mkdirSync(join(repo.dir, "d\u00e9"));
    writeFileSync(join(repo.dir, "d\u00e9", "AGENTS.md"), "nested guidance\n");
    repo.git(["add", "."]);
    repo.git(["commit", "-q", "-m", "non-ascii"]);
    // Git prints the path in its quoted form, which is ASCII, so no output chunk can split a character.
    const quoted = repo.git(["-c", "core.quotePath=true", "ls-tree", "-r", "--name-only", "HEAD"]).split("\n").find(path => path.includes("AGENTS.md"))!;
    assert.match(quoted, /^"[\x20-\x7e]+\/AGENTS\.md"$/, "the path is quoted and ASCII");
    const object = repo.git(["ls-tree", "-r", "HEAD"]).split("\n").find(row => row.includes("AGENTS.md"))!.split(/\s+/)[2]!;
    const digest = await readGuidanceDigest(repo.dir, repo.git(["rev-parse", "HEAD"]), undefined, new AbortController().signal);
    assert.equal(digest, guidanceDigest([{ path: quoted, object }]));
  } finally {
    repo.cleanup();
  }
});

test("guidance is read from a commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "config-identity-"));
  try {
    const git = (args: string[]) => execFileSync("git", [...GIT_ARGS, ...args], { cwd: dir, encoding: "utf8" }).trim();
    git(["init", "-q", "--template="]);
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "AGENTS.md"), "root guidance\n");
    writeFileSync(join(dir, "a", "CLAUDE.md"), "nested guidance\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "first"]);
    const first = git(["rev-parse", "HEAD"]);
    const expected = guidanceDigest([
      { path: "AGENTS.md", object: git(["rev-parse", "HEAD:AGENTS.md"]) },
      { path: "a/CLAUDE.md", object: git(["rev-parse", "HEAD:a/CLAUDE.md"]) },
    ]);
    const signal = new AbortController().signal;
    assert.equal(await readGuidanceDigest(dir, first, undefined, signal), expected);

    writeFileSync(join(dir, "a", "CLAUDE.md"), "edited guidance\n");
    git(["commit", "-q", "-am", "second"]);
    const second = git(["rev-parse", "HEAD"]);
    const next = await readGuidanceDigest(dir, second, undefined, signal);
    assert.match(next ?? "", HEX64);
    assert.notEqual(next, expected);
    assert.equal(await readGuidanceDigest(dir, first, undefined, signal), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed guidance read gives nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "config-identity-"));
  try {
    execFileSync("git", ["init", "-q", "--template="], { cwd: dir });
    const live = new AbortController().signal;
    assert.equal(await readGuidanceDigest(dir, "f".repeat(40), undefined, live), undefined);

    const exitsOne = { command: "false", args: [] };
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "empty"], { cwd: dir });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(await readGuidanceDigest(dir, head, exitsOne, live), undefined);

    const aborted = new AbortController();
    aborted.abort();
    assert.equal(await readGuidanceDigest(dir, head, undefined, aborted.signal), undefined);

    const configuration = await memberConfiguration({ workspace: dir, baseCommit: "f".repeat(40), role: "implementer", provider: "claude", publishHeads: true }, live);
    assert.equal(configuration, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
