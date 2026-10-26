import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "@infinite/attention";
import { collectPermissionEvidence } from "../packages/host/src/team-permission-evidence.js";

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "permission-evidence-repo-"));
  mkdirSync(join(cwd, ".git"));
  return cwd;
}

function screen(command: string): Prompt {
  return {
    id: 1, kind: "permission", title: "Would you like to run the following command?",
    detail: `$ ${command}`, options: [], acceptsText: false, source: "screen", pinned: true,
  };
}

test("collects complete package script and local source evidence, then changes its digest on drift", () => {
  const cwd = workspace();
  try {
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node scripts/check.mjs" } }));
    writeFileSync(join(cwd, "scripts/check.mjs"), 'import "./shared.mjs";\nconsole.log("check");\n');
    writeFileSync(join(cwd, "scripts/shared.mjs"), "export const checked = true;\n");
    const input = { prompt: screen("npm test"), cwd, changedPaths: ["scripts/check.mjs"] };
    const first = collectPermissionEvidence(input);
    assert.deepEqual(first.files.map(file => file.path), ["package.json", "scripts/check.mjs", "scripts/shared.mjs"]);
    for (const file of first.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(first.files.every(file => !file.path.startsWith("/")));
    writeFileSync(join(cwd, "scripts/shared.mjs"), "export const checked = false;\n");
    const second = collectPermissionEvidence(input);
    assert.notEqual(first.digest, second.digest, "answer-time recollection detects source changes");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("refuses paths outside the repository and symlinked script sources", () => {
  const cwd = workspace();
  try {
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(join(cwd, "scripts/hidden.mjs"), "console.log('outside');\n");
    symlinkSync(join(cwd, "scripts/hidden.mjs"), join(cwd, "scripts/alias.mjs"));
    const outsideResult = collectPermissionEvidence({ prompt: screen("node ../../etc/passwd.mjs"), cwd, changedPaths: [] });
    assert.equal(outsideResult.files.length, 0);
    assert.match(outsideResult.limitations.join("\n"), /outside the repository or a host-approved scratch root/);
    const symlinkResult = collectPermissionEvidence({ prompt: screen("node scripts/alias.mjs"), cwd, changedPaths: [] });
    assert.equal(symlinkResult.files.length, 0);
    assert.match(symlinkResult.limitations.join("\n"), /traverses a symlink/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("omits oversized files completely and reports the collection gap", () => {
  const cwd = workspace();
  try {
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(join(cwd, "scripts/large.mjs"), "x".repeat(16 * 1024 + 1));
    const result = collectPermissionEvidence({ prompt: screen("node scripts/large.mjs"), cwd, changedPaths: [] });
    assert.deepEqual(result.files, []);
    assert.match(result.limitations.join("\n"), /exceeds the 16384-byte evidence limit and was omitted/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("reads scratch sources only from explicit host-approved roots", () => {
  const cwd = workspace();
  const tempRoot = mkdtempSync(join(tmpdir(), "permission-evidence-script-"));
  try {
    const script = join(realpathSync(tempRoot), "probe.mjs");
    const neighborName = `${tempRoot.split("/").at(-1)}-neighbor.mjs`;
    writeFileSync(join(tempRoot, "..", neighborName), "console.log('outside scratch');\n");
    writeFileSync(script, `import "../${neighborName}";\nconsole.log('local probe');\n`);
    const denied = collectPermissionEvidence({ prompt: screen(`node ${script}`), cwd, changedPaths: [] });
    assert.equal(denied.files.length, 0);
    assert.match(denied.limitations.join("\n"), /host-approved scratch root/);
    const result = collectPermissionEvidence({ prompt: screen(`node ${script}`), cwd, changedPaths: [], approvedScratchRoots: [realpathSync(tempRoot)] });
    assert.equal(result.files[0]?.path, "@scratch/0/probe.mjs");
    assert.equal(result.files[0]?.content, `import "../${neighborName}";\nconsole.log('local probe');\n`);
    assert.equal(result.files.some(file => file.path.endsWith(neighborName)), false);
    assert.match(result.limitations.join("\n"), /outside the repository or a host-approved scratch root/);
    const symlinkRoot = join(cwd, "scratch-link");
    symlinkSync(realpathSync(tempRoot), symlinkRoot);
    const rejectedRoot = collectPermissionEvidence({ prompt: screen(`node ${script}`), cwd, changedPaths: [], approvedScratchRoots: [symlinkRoot] });
    assert.equal(rejectedRoot.files.length, 0);
    assert.match(rejectedRoot.limitations.join("\n"), /scratch root/);
  } finally {
    rmSync(join(tempRoot, "..", `${tempRoot.split("/").at(-1)}-neighbor.mjs`), { force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolves workspace scripts and their configs from the selected package directory", () => {
  const cwd = workspace();
  try {
    mkdirSync(join(cwd, "scripts"));
    mkdirSync(join(cwd, "packages/widget/scripts"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node scripts/check.mjs" } }));
    writeFileSync(join(cwd, "scripts/check.mjs"), "console.log('root decoy');\n");
    writeFileSync(join(cwd, "packages/widget/package.json"), JSON.stringify({ scripts: { test: "node scripts/check.mjs && vitest --config vitest.config.ts" } }));
    writeFileSync(join(cwd, "packages/widget/scripts/check.mjs"), "console.log('workspace check');\n");
    writeFileSync(join(cwd, "packages/widget/vitest.config.ts"), "export default {};\n");
    writeFileSync(join(cwd, "vitest.config.ts"), "export default { rootDecoy: true };\n");
    for (const selector of ["-w packages/widget", "--workspace packages/widget", "--workspace=packages/widget", "-wpackages/widget"]) {
      const result = collectPermissionEvidence({ prompt: screen(`npm run test ${selector}`), cwd, changedPaths: [] });
      const paths = result.files.map(file => file.path);
      assert.ok(paths.includes("packages/widget/package.json"));
      assert.ok(paths.includes("packages/widget/scripts/check.mjs"));
      assert.ok(paths.includes("packages/widget/vitest.config.ts"));
      assert.ok(!paths.includes("scripts/check.mjs"));
      assert.ok(!paths.includes("vitest.config.ts"));
      assert.deepEqual(result.limitations, [], selector);
    }
    for (const selector of ["--workspaces", "--prefix packages/widget", "-C packages/widget", "-w packages/widget -w packages/other", "--workspace=packages/widget --workspaces", "--work=packages/widget"]) {
      const result = collectPermissionEvidence({ prompt: screen(`npm run test ${selector}`), cwd, changedPaths: [] });
      assert.ok(result.limitations.length, selector);
      assert.ok(!result.files.some(file => file.path === "scripts/check.mjs"), selector);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("reports package scripts with unsupported directory changes", () => {
  const cwd = workspace();
  try {
    mkdirSync(join(cwd, "packages/widget"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    writeFileSync(join(cwd, "packages/widget/package.json"), JSON.stringify({ scripts: { test: "cd ../.. && node scripts/check.mjs" } }));
    const result = collectPermissionEvidence({ prompt: screen("npm run test -w packages/widget"), cwd, changedPaths: [] });
    assert.match(result.limitations.join("\n"), /changes directory/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("accepts a literal scoped staging and conflict-check chain without requiring a script file", () => {
  const cwd = workspace();
  try {
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(join(cwd, "scripts/run.mjs"), "console.log('task check');\n");
    const result = collectPermissionEvidence({
      prompt: screen("git add scripts/run.mjs && git diff --check"),
      cwd,
      changedPaths: ["scripts/run.mjs"],
    });
    assert.deepEqual(result.limitations, []);
    assert.deepEqual(result.files.map(file => file.path), ["scripts/run.mjs"]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("an emitted .js import specifier is read from its TypeScript source", () => {
  const cwd = workspace();
  try {
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, "tests"));
    writeFileSync(join(cwd, "tests/retire.test.ts"), 'import { stop } from "../src/retire.js";\nstop();\n');
    writeFileSync(join(cwd, "src/retire.ts"), "export function stop() {}\n");
    const snapshot = collectPermissionEvidence({ prompt: screen("node --import tsx --test tests/retire.test.ts"), cwd, changedPaths: ["tests/retire.test.ts"] });
    assert.deepEqual(snapshot.files.map(file => file.path).sort(), ["src/retire.ts", "tests/retire.test.ts"]);
    assert.ok(!snapshot.limitations.some(limitation => /retire/.test(limitation)), snapshot.limitations.join("\n"));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("collects the config and test behind a literal environment assignment and package runner", () => {
  const cwd = workspace();
  try {
    mkdirSync(join(cwd, "tests"));
    writeFileSync(join(cwd, "playwright.config.ts"), "export default {};\n");
    writeFileSync(join(cwd, "tests/capture.spec.ts"), 'test("capture", () => {});\n');
    for (const command of [
      "E2E_CAPTURE=1 npx playwright test --config=playwright.config.ts tests/capture.spec.ts",
      "E2E_CAPTURE=1 npm exec -- playwright test --config=playwright.config.ts tests/capture.spec.ts",
    ]) {
      const result = collectPermissionEvidence({ prompt: screen(command), cwd, changedPaths: [] });
      assert.deepEqual(result.files.map(file => file.path), ["playwright.config.ts", "tests/capture.spec.ts"]);
      assert.deepEqual(result.limitations, [], command);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("does not map package aliases or npm exec package-selection options", () => {
  const cwd = workspace();
  try {
    writeFileSync(join(cwd, "a.spec.ts"), 'test("capture", () => {});\n');
    const commands = [
      "npx @alternate/playwright test a.spec.ts",
      "npx ./node_modules/.bin/playwright test a.spec.ts",
      "npm --package=alternate-runner exec -- playwright test a.spec.ts",
      "npm exec --package=alternate-runner -- playwright test a.spec.ts",
      "npm exec -- ./node_modules/.bin/playwright test a.spec.ts",
    ];
    for (const command of commands) {
      const result = collectPermissionEvidence({ prompt: screen(command), cwd, changedPaths: [] });
      assert.deepEqual(result.files, [], command);
      assert.ok(result.limitations.length > 0, command);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("does not treat quoted or escaped assignment-like words as environment assignments", () => {
  const cwd = workspace();
  try {
    writeFileSync(join(cwd, "a.spec.ts"), 'test("capture", () => {});\n');
    for (const command of [
      '"E2E_CAPTURE=1" npx playwright test a.spec.ts',
      "E2E_CAPTURE\\=1 npx playwright test a.spec.ts",
    ]) {
      const result = collectPermissionEvidence({ prompt: screen(command), cwd, changedPaths: [] });
      assert.deepEqual(result.files, [], command);
      assert.match(result.limitations.join("\n"), /No supported static source mapping/);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("keeps semantic newlines in a wrapped screen command incomplete", () => {
  const cwd = workspace();
  try {
    writeFileSync(join(cwd, "capture.spec.ts"), 'test("capture", () => {});\n');
    const result = collectPermissionEvidence({
      prompt: screen("npx playwright test capture.spec.ts\ngit status"), cwd, changedPaths: [],
    });
    assert.deepEqual(result.files, []);
    assert.match(result.limitations.join("\n"), /multiple lines/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("collects coordinator-requested paths with complete content and binds drift into the digest", () => {
  const cwd = workspace();
  try {
    mkdirSync(join(cwd, "src"));
    const path = "src/requested.ts";
    const content = "export const requested = 'complete source';\n";
    writeFileSync(join(cwd, path), content);
    const input = { prompt: screen("git status"), cwd, changedPaths: [], requestedPaths: [path] };
    const first = collectPermissionEvidence(input);
    assert.deepEqual(first.files.map(file => file.path), [path]);
    assert.equal(first.files[0]?.content, content);
    assert.deepEqual(first.limitations, []);
    writeFileSync(join(cwd, path), "export const requested = 'changed source';\n");
    const second = collectPermissionEvidence(input);
    assert.notEqual(first.digest, second.digest, "requested source drift changes the answer-time evidence digest");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("bounds coordinator-requested paths and refuses paths outside safe roots", () => {
  const cwd = workspace();
  try {
    mkdirSync(join(cwd, "src"));
    for (let index = 0; index < 9; index++) writeFileSync(join(cwd, `src/requested-${index}.ts`), `export const value = ${index};\n`);
    writeFileSync(join(cwd, "src/other.ts"), "export const other = true;\n");
    const prefix = Array.from({ length: 8 }, (_, index) => `src/requested-${index}.ts`);
    const bounded = collectPermissionEvidence({
      prompt: screen("git status"), cwd, changedPaths: [], requestedPaths: [...prefix, "src/requested-8.ts"],
    });
    assert.equal(bounded.files.length, 8);
    assert.match(bounded.limitations.join("\n"), /8-path limit/);
    const differentOmission = collectPermissionEvidence({
      prompt: screen("git status"), cwd, changedPaths: [], requestedPaths: [...prefix, "src/other.ts"],
    });
    assert.notEqual(bounded.digest, differentOmission.digest, "the digest binds paths omitted by the request cap");

    writeFileSync(join(cwd, "src/safe.ts"), "export const safe = true;\n");
    symlinkSync(join(cwd, "src/safe.ts"), join(cwd, "src/alias.ts"));
    writeFileSync(join(cwd, ".env.local"), "placeholder=value\n");
    const refused = collectPermissionEvidence({
      prompt: screen("git status"), cwd, changedPaths: [],
      requestedPaths: ["../outside.ts", ".env.local", "src/alias.ts"],
    });
    assert.deepEqual(refused.files, []);
    assert.match(refused.limitations.join("\n"), /outside the repository/);
    assert.match(refused.limitations.join("\n"), /excluded or unsafe/);
    assert.match(refused.limitations.join("\n"), /traverses a symlink/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
