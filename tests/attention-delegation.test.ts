import test from "node:test";
import assert from "node:assert/strict";
import type { Prompt } from "@infinite/attention";
import { detectPrompt, dialogCommand, oneShotPermissionOption } from "@infinite/attention";

const dialog: Prompt = {
  id: 7,
  kind: "permission",
  title: "Would you like to run the following command?",
  detail: [
    "• Running npm run check",
    "Environment: local",
    "Reason: May I run the requested full npm run check outside the sandbox? Its tsx test runner needs a local IPC socket",
    "that the sandbox blocks.",
    "$ npm run check",
  ].join("\n"),
  options: [
    { index: 0, label: "Yes, proceed (y)", role: "accept" },
    { index: 1, label: "Yes, and don't ask again for commands that start with … (p)", role: "accept-always" },
    { index: 2, label: "No, and tell Codex what to do differently (esc)", role: "reject-with-feedback" },
  ],
  acceptsText: true,
  pinned: true,
  source: "screen",
  hash: "complete-screen-evidence",
};

test("a complete Codex command dialog exposes its one-shot option", () => {
  assert.equal(dialogCommand(dialog), "npm run check");
  assert.equal(oneShotPermissionOption(dialog), 0);
});

test("a visually wrapped command retains its full screen evidence", () => {
  const wrappedCommand = ["npm run " + String.fromCharCode(92), "check"].join("\n");
  const wrapped = { ...dialog, detail: dialog.detail?.replace("$ npm run check", `$ ${wrappedCommand}`) };
  assert.equal(dialogCommand(wrapped), wrappedCommand);
  assert.equal(oneShotPermissionOption(wrapped), 0);
});

test("one-shot review fails closed without complete and bounded evidence", () => {
  assert.equal(oneShotPermissionOption({ ...dialog, hash: undefined }), undefined);
  assert.equal(oneShotPermissionOption({ ...dialog, pinned: false }), undefined);
  assert.equal(oneShotPermissionOption({ ...dialog, pinned: undefined }), undefined);
  // A second `$ ` line, from the transcript above the title or written into the reason, hides which one is the command.
  const twoCommands = { ...dialog, detail: `$ npm test\n${dialog.detail}` };
  assert.equal(dialogCommand(twoCommands), undefined);
  assert.equal(oneShotPermissionOption(twoCommands), undefined);
  assert.equal(oneShotPermissionOption({ ...dialog, title: "Run this command?" }), undefined);

  const truncated: Prompt = { ...dialog, detail: dialog.detail?.replace("$ npm run check", "$ npm run check…") };
  assert.equal(dialogCommand(truncated), undefined);
  assert.equal(oneShotPermissionOption(truncated), undefined);

  const incompleteHook: Prompt = {
    ...dialog,
    source: "hook",
    tool: { name: "Bash", input: { command: "npm run check" }, inputComplete: false },
  };
  assert.equal(oneShotPermissionOption(incompleteHook), undefined);
  assert.equal(oneShotPermissionOption({ ...dialog, destructive: { pattern: "rm-recursive-force" } }), undefined);
  assert.equal(oneShotPermissionOption({ ...dialog, multiSelect: true }), undefined);
  assert.equal(oneShotPermissionOption({ ...dialog, options: dialog.options.slice(0, 2) }), undefined);

  const persistentYes: Prompt = {
    ...dialog,
    options: [
      { index: 0, label: "Yes, and don't ask again for commands that start with … (p)", role: "accept-always" },
      dialog.options[2],
    ],
  };
  assert.equal(oneShotPermissionOption(persistentYes), undefined);
});

// The Codex 0.163 command dialog as the host's terminal rendered it on a live run: the bottom of
// the screen, under the transcript, with its key hint on the last row.
const codexDialog = [
  "• Running npm run check",
  "",
  "",
  "  Would you like to run the following command?",
  "",
  "  Environment: local",
  "",
  "  Reason: May I run the requested full npm run check outside the sandbox? Its tsx test runner needs a local IPC socket",
  "  that the sandbox blocks.",
  "",
  "  $ npm run  check",
  "",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `npm run  check` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
];
const codexComposer = ["", "• Working (12s • esc to interrupt)", "", "› Ask Codex to do anything", "", "  ? for shortcuts"];

/** The prompt the worker opens for a detected block, as `screenDecision` builds it. */
function screenPromptOf(lines: string[]): Prompt | undefined {
  const detected = detectPrompt(lines, "codex");
  if (!detected) return undefined;
  const { fingerprint: _fingerprint, blockStart: _start, blockEnd: _end, ...prompt } = detected;
  return { ...prompt, id: 1, source: "screen", hash: "screen-hash" };
}

test("the live Codex dialog layout is pinned and keeps its command spacing", () => {
  const prompt = screenPromptOf(codexDialog)!;
  assert.equal(prompt.pinned, true);
  assert.equal(dialogCommand(prompt), "npm run  check");
  assert.equal(oneShotPermissionOption(prompt), 0);
});

test("dialog text printed in the transcript is never delegable", () => {
  // Agent output scrolls above Codex's own input area, so a copied dialog is followed by it.
  const printed = screenPromptOf([...codexDialog, ...codexComposer])!;
  assert.equal(printed.title, "Would you like to run the following command?");
  assert.equal(printed.pinned, false);
  assert.equal(oneShotPermissionOption(printed), undefined);
  // A printed dialog above a real yes/no prompt is still not the active dialog.
  const aboveYesNo = screenPromptOf([...codexDialog, "", "Overwrite the lockfile? [Y/n]"])!;
  assert.equal(aboveYesNo.pinned, false);
  assert.equal(oneShotPermissionOption(aboveYesNo), undefined);
});

const questionReasonDialog = [
  "• Running node --import tsx --test tests/team-member-retire.test.ts",
  "",
  "  Would you like to run the following command?",
  "",
  "  Environment: local",
  "",
  "  Reason: May I rerun the focused retirement integration test outside the sandbox after correcting the async",
  "  inspection route?",
  "",
  "  $ node --import tsx --test tests/team-member-retire.test.ts",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for commands that start with `node --import tsx --test` (p)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
];

test("a Codex reason phrased as a question does not displace the dialog title", () => {
  const prompt = screenPromptOf(questionReasonDialog)!;
  assert.equal(prompt.title, "Would you like to run the following command?");
  assert.equal(prompt.kind, "permission");
  // The header starts at the title: the transcript line above it is not part of the dialog.
  assert.doesNotMatch(prompt.detail ?? "", /• Running/);
  assert.match(prompt.detail ?? "", /inspection route\?/);
  assert.equal(prompt.pinned, true);
  assert.equal(dialogCommand(prompt), "node --import tsx --test tests/team-member-retire.test.ts");
  assert.equal(oneShotPermissionOption(prompt), 0);
});

test("a long wrapped reason keeps the title inside the dialog header", () => {
  const reason = Array.from({ length: 7 }, (_, index) => `  reason line ${index + 1} of a long explanation that the terminal wrapped`);
  const prompt = screenPromptOf([
    "• Running npm run check", "", "  Would you like to run the following command?", "", "  Environment: local", "",
    ...reason, "  so may I run it outside the sandbox?", "", "  $ npm run check", "",
    "› 1. Yes, proceed (y)", "  2. Yes, and don't ask again for commands that start with `npm run check` (p)", "  3. No, and tell Codex what to do differently (esc)",
    "", "  Press enter to confirm or esc to cancel",
  ])!;
  assert.equal(prompt.title, "Would you like to run the following command?");
  assert.equal(dialogCommand(prompt), "npm run check");
  assert.equal(oneShotPermissionOption(prompt), 0);
});

test("a Claude dialog still takes its bottom question as the title", () => {
  const prompt = screenPromptOf([
    "╭──────────────────────────────╮",
    "│ Bash command                 │",
    "│ npm test                     │",
    "│ Does the suite pass locally? │",
    "│ Do you want to proceed?      │",
    "│ ❯ 1. Yes                     │",
    "│   2. Yes, and don't ask again for similar commands in this project │",
    "│   3. No, and tell Claude what to do differently (esc) │",
    "╰──────────────────────────────╯",
  ])!;
  assert.equal(prompt.title, "Do you want to proceed?");
  assert.match(prompt.detail ?? "", /Does the suite pass locally\?/);
});

test("a dialog whose detail runs past the parser's cap is marked truncated and never qualifies", () => {
  const filler = Array.from({ length: 8 }, (_, index) => `  Reason line ${index + 1}: ${"x".repeat(230)}`);
  const prompt = screenPromptOf([
    "  Would you like to run the following command?", "", "  Environment: local", "", ...filler, "",
    "  $ npm run check && npm run release:promote --tag production", "",
    "› 1. Yes, proceed (y)", "  2. Yes, and don't ask again for commands that start with `npm run check` (p)", "  3. No, and tell Codex what to do differently (esc)",
    "", "  Press enter to confirm or esc to cancel",
  ])!;
  assert.equal(prompt.title, "Would you like to run the following command?");
  assert.match(prompt.detail ?? "", /… \[\+\d+ chars\]$/);
  assert.equal(dialogCommand(prompt), undefined, "a cut command is not a complete command");
  assert.equal(oneShotPermissionOption(prompt), undefined);
});
