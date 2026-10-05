// Scripted agent for tests/worker-attention.test.ts. It draws one Claude-style permission dialog
// for `rm -rf build` and posts PermissionRequest hooks in a fixed order, so each mode drives one
// of the worker's rules for merging hook prompts with the dialog on screen.
const mode = process.argv[2] ?? "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const post = (body) =>
  fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}` },
    body: JSON.stringify(body),
  }).catch(() => {});
const permission = (command) => post({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } });

const HEADER = ["Bash command", "  rm -rf build", "", "Do you want to proceed?"];
const OPTIONS = ["Yes", "No"];
let highlighted = 0;
let open = false;
let raceHook = Promise.resolve();
const rows = () => OPTIONS.map((label, i) => `${i === highlighted ? "❯" : " "} ${i + 1}. ${label}`);
function draw() {
  open = true;
  console.log([...HEADER, ...rows()].join("\n"));
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  if (!open) return;
  if (chunk.includes("\x1b[B") || chunk.includes("\x1b[A")) {
    highlighted = chunk.includes("\x1b[B") ? Math.min(OPTIONS.length - 1, highlighted + 1) : Math.max(0, highlighted - 1);
    process.stdout.write(`\x1b[${OPTIONS.length}A` + rows().map((row) => `\x1b[2K${row}\n`).join(""));
    // A hook for this very dialog arrives while the answer is still in flight.
    if (mode === "answer-race") raceHook = permission("rm -rf build");
  } else if (chunk.includes("\r")) {
    await raceHook; // keep the dialog on screen until that hook was delivered
    open = false;
    process.stdout.write(`\x1b[${HEADER.length + OPTIONS.length}A\x1b[J`);
    console.log(`Selected: ${OPTIONS[highlighted]}`);
  }
});

await sleep(300);
if (mode === "mismatch") {
  draw();
  await sleep(400);
  await permission("git push --force origin main");
} else if (mode === "hook-first") {
  await permission("git push --force origin main");
  await sleep(400);
  draw();
} else if (mode === "two-hooks") {
  await permission("rm -rf build");
  await sleep(300);
  await permission("git push --force origin main");
} else if (mode === "answer-race") draw();
else if (mode === "merge") {
  // The hook for this very dialog arrives first; the block then supplies title, detail and options.
  await permission("rm -rf build");
  await sleep(400);
  draw();
} else if (mode === "denied") {
  // No dialog is drawn: the permission is refused without asking.
  await permission("rm -rf build");
  await sleep(300);
  await post({ hook_event_name: "PermissionDenied", tool_name: "Bash", tool_input: { command: "rm -rf build" }, reason: "Denied by policy" });
}
setInterval(() => {}, 1000);
