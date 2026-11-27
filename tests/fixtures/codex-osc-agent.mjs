const gateIndex = process.argv.indexOf("--gate");
const gateBase = gateIndex >= 0 ? process.argv[gateIndex + 1] : undefined;
const step = async (name) => {
  if (gateBase) await fetch(`${gateBase}/${name}`).catch(() => {});
};
const notify = (body) =>
  fetch(`${process.env.INFINITE_HOOK_URL}/codex-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}` },
    body: JSON.stringify(body),
  }).catch(() => {});

process.stdout.write("Codex ready\n");
await step("preview-before-notify");
process.stdout.write("\x1b]9;Codex wants to edit 2 files before merging.\x07preview-rendered\n");
await step("codex-notify");
await notify({
  type: "agent-turn-complete",
  "thread-id": "codex-osc-thread",
  "turn-id": "turn-1",
  cwd: "/workspace",
  "input-messages": ["inspect files"],
  "last-assistant-message": "Codex wants to edit 2 files before merging.",
});
await step("late-preview");
process.stdout.write("\x1b]9;Approval requested: npm test\x07late-preview-rendered\n");
await step("late-completion-preview");
process.stdout.write("\x1b]9;Agent turn complete: Fixed tests\x07late-completion-rendered\n");
await step("dialog-open");
process.stdout.write(
  "\x1b[2J\x1b[H" +
  [
    "Would you like to run the following command?",
    "$ npm test",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)",
  ].join("\n") +
  "\n\x1b]9;Approval requested: npm test\x07",
);
await step("dialog-clear");
process.stdout.write("\x1b[2J\x1b[HDialog cleared\n");
await step("osc9-turn-end");
process.stdout.write("\x1b]9;Agent turn complete\x07");
await step("osc777-plan");
process.stdout.write(
  "\x1b[2J\x1b[H\n" +
  [
    "╭────────────────────────────────────────╮",
    "Implement this plan?",
    "› 1. Yes, implement this plan",
    "  2. No, stay in Plan mode",
  ].join("\n") +
  "\n\x1b]777;notify;Codex;Plan mode prompt: Implement this plan?\x1b\\",
);
await step("osc777-other");
process.stdout.write("\x1b]777;notify;Other;Agent turn complete\x1b\\\x1b[1;1Hafter-other-osc777");
await step("osc777-turn-end");
process.stdout.write("\x1b[2J\x1b[H\x1b]777;notify;Codex;Agent turn complete\x1b\\");
setInterval(() => {}, 1000);
