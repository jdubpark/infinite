import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPrompt } from "../packages/attention/src/prompts.js";
import { buildLaunch } from "../packages/host/src/launch.js";
import { acceptClaudeWorkspaceTrust, coordinatorJudgeLaunch, coordinatorJudgePrompt, parseCoordinatorVerdict, teamApprovalChoice, withClaudeWorkspaceTrust } from "../packages/host/src/team-approval.js";

const cwd = "/srv/infinite-data/workspaces/teams/run/members/member";
const hooks = { url: "http://127.0.0.1:4321/hook", token: "tok" };
const relay = "/opt/infinite/packages/host/dist/hook-relay.js";

test("the workspace trust dialog is a permission prompt for the shown directory", () => {
  const prompt = detectPrompt(readFileSync(new URL("./fixtures/screens/claude-trust.txt", import.meta.url), "utf8").split("\n"), "claude");
  assert.ok(prompt);
  assert.equal(prompt.kind, "permission");
  assert.equal(prompt.highlighted, 0);
  assert.equal(prompt.options[1].role, "accept");
  assert.equal(teamApprovalChoice(prompt, cwd).action, "accept");
  assert.equal((teamApprovalChoice(prompt, cwd) as { option: number }).option, 1);
  assert.equal(teamApprovalChoice(prompt, "/srv/other").action, "leave");
});

test("a trust dialog whose spaces were collapsed is still recognized", () => {
  const lines = [
    "Accessingworkspace:",
    cwd,
    "Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?",
    "❯No,exit",
    "Yes,Itrustthisfolder",
  ];
  const prompt = detectPrompt(lines, "claude");
  assert.equal(teamApprovalChoice(prompt!, cwd).action, "accept");
});

test("ordinary permission prompts are accepted and destructive ones go to the coordinator", () => {
  const ordinary = detectPrompt(readFileSync(new URL("./fixtures/screens/codex-command.txt", import.meta.url), "utf8").split("\n"), "codex");
  assert.equal(ordinary?.kind, "permission");
  assert.deepEqual(teamApprovalChoice(ordinary!, cwd), { action: "accept", option: 0 });
  assert.deepEqual(teamApprovalChoice({
    kind: "permission", title: "Do you want to proceed?", detail: "npm test", options: [
      { index: 0, label: "Yes, and don't ask again", role: "accept-always" },
      { index: 1, label: "Yes", role: "accept" },
      { index: 2, label: "No", role: "reject" },
    ],
  }, cwd), { action: "accept", option: 1 });
  assert.equal(teamApprovalChoice({
    kind: "permission", title: "Permission needed", detail: "original.txt", options: [],
  }, cwd).action, "leave");
  const destructive = detectPrompt(readFileSync(new URL("./fixtures/screens/claude-permission.txt", import.meta.url), "utf8").split("\n"), "claude");
  assert.equal(teamApprovalChoice(destructive!, cwd).action, "ask-coordinator");
  assert.equal(teamApprovalChoice({
    kind: "permission", title: "Do you want to proceed?", detail: "git push origin main", options: [
      { index: 0, label: "Yes", role: "accept" },
      { index: 1, label: "No", role: "reject" },
    ],
  }, cwd).action, "ask-coordinator");
  assert.equal(teamApprovalChoice({
    kind: "question", title: "Which storage should the alarm use?", options: [
      { index: 0, label: "Phone", role: "other" },
      { index: 1, label: "Laptop", role: "other" },
    ],
  }, cwd).action, "leave");
});

test("Claude trust is recorded for the assigned workspace only", () => {
  const next = withClaudeWorkspaceTrust(JSON.stringify({ numStartups: 3, projects: { "/keep": { hasTrustDialogAccepted: false } } }), cwd);
  const parsed = JSON.parse(next);
  assert.equal(parsed.numStartups, 3);
  assert.equal(parsed.projects["/keep"].hasTrustDialogAccepted, false);
  assert.equal(parsed.projects[cwd].hasTrustDialogAccepted, true);
  assert.equal(withClaudeWorkspaceTrust(next, cwd), next);
  const root = mkdtempSync(join(tmpdir(), "inf-trust-"));
  try {
    const file = join(root, ".claude.json");
    acceptClaudeWorkspaceTrust(file, cwd);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).projects[cwd].hasTrustDialogAccepted, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.throws(() => withClaudeWorkspaceTrust("{}", "/"));
});

test("the coordinator verdict is one JSON object, and its launch cannot use the member permission bypass", () => {
  assert.deepEqual(parseCoordinatorVerdict("thinking\n{\"allow\":false,\"reason\":\"pushes the branch\"}\n"), { allow: false, reason: "pushes the branch" });
  assert.equal(parseCoordinatorVerdict("no decision"), null);
  const prompt = coordinatorJudgePrompt({ workspace: cwd, role: "implementer", title: "Do you want to proceed?", detail: "git push", options: ["Yes", "No"] });
  const launch = coordinatorJudgeLaunch({ command: "claude", args: ["--model", "claude-opus-5-5"] }, prompt);
  assert.equal(launch.command, "claude");
  assert.equal(launch.args.at(-1), prompt);
  assert.ok(launch.args.includes("--print"));
  assert.ok(!launch.args.some(arg => /dangerously-skip-permissions|bypassPermissions/.test(arg)));
  const kept = buildLaunch("claude", { command: "claude", args: ["--permission-mode", "plan"] }, "task", hooks, relay, { claude: true, codex: true }, true);
  assert.equal(kept.args.filter(arg => arg === "--permission-mode").length, 1);
  assert.equal(kept.args[kept.args.indexOf("--permission-mode") + 1], "plan");
  const ordinary = buildLaunch("claude", { command: "claude", args: ["--model", "opus"] }, "task", hooks, relay, { claude: true, codex: true }, false);
  assert.equal(ordinary.args.includes("--permission-mode"), false);
});
