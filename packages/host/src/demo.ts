const request = process.argv[2] ?? "";
console.log("Infinite · local continuity rehearsal");
console.log("This is a deterministic demo process. No model requests are made.");
console.log(`Process ${process.pid} stays alive when clients disconnect.\n`);
if (request) console.log(`Initial request: ${request}\n`);

const hookUrl = process.env.INFINITE_HOOK_URL;
const hookToken = process.env.INFINITE_HOOK_TOKEN;
const withHooks = request.includes("hook") && Boolean(hookUrl) && Boolean(hookToken);
async function post(body: Record<string, unknown>) {
  await fetch(`${hookUrl}/claude`, {
    signal: AbortSignal.timeout(1500),
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${hookToken}` },
    body: JSON.stringify({ session_id: "demo", transcript_path: "/dev/null", cwd: process.cwd(), permission_mode: "default", ...body }),
  }).catch(() => {});
}
// Hooks go out in order on a chain that drawing and printing never await.
let chain: Promise<void> = Promise.resolve();
function hook(body: Record<string, unknown>) {
  if (!withHooks) return;
  chain = chain.then(() => post(body)).catch(() => {});
}

const OPTIONS = ["Yes", "Yes, and don't ask again for rm commands", "No, and tell Claude what to do differently"];
let dialog: { highlighted: number } | null = null;
let rawBuffer = "";
let lineBuffer = "";
let awaitingYesNo = false;

const HEADER = "\nBash command\n  rm -rf build\n  Remove the stale build directory\n\nDo you want to proceed?";
// Rows the dialog occupies: the header's lines plus one per option.
const DIALOG_ROWS = HEADER.split("\n").length + OPTIONS.length;

function drawDialog() {
  console.log(HEADER);
  OPTIONS.forEach((label, i) => console.log(`${dialog && dialog.highlighted === i ? "❯" : " "} ${i + 1}. ${label}`));
}
function redraw() {
  // Move the cursor up over the option lines and redraw them in place.
  process.stdout.write(`\x1b[${OPTIONS.length}A`);
  OPTIONS.forEach((label, i) => process.stdout.write(`\x1b[2K${dialog && dialog.highlighted === i ? "❯" : " "} ${i + 1}. ${label}\n`));
}
const RM_INPUT = { command: "rm -rf build", description: "Remove the stale build directory" };
const turnHooks = () => {
  hook({ hook_event_name: "UserPromptSubmit", prompt: request });
  hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: RM_INPUT, tool_use_id: "demo-1" });
};
const permissionHook = () => hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: RM_INPUT, permission_suggestions: [] });
// `dialog-first` draws the dialog and posts every hook about 300 ms later, so the screen
// reports the prompt before any hook does.
const dialogFirst = request.includes("dialog-first");
function openDialog() {
  if (!dialogFirst) turnHooks();
  dialog = { highlighted: 0 };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  drawDialog();
  if (!dialogFirst) permissionHook();
  else setTimeout(() => { turnHooks(); permissionHook(); }, 300);
}
function selectOption(index: number) {
  const label = OPTIONS[index];
  dialog = null;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  // Like Claude Code and Codex, the dialog disappears once answered: erase it from the screen.
  process.stdout.write(`\x1b[${DIALOG_ROWS}A\x1b[J`);
  console.log(`\nSelected: ${label}\n`);
  if (index === 2) {
    console.log("Tell Claude what to do differently:");
  } else {
    hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_response: { stdout: "", exitCode: 0 }, tool_use_id: "demo-1", duration_ms: 42 });
    hook({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "Removed the build directory. Nothing else changed.", background_tasks: [] });
  }
  process.stdout.write("\n> ");
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (dialog) {
    rawBuffer += chunk;
    if (rawBuffer.includes("\x1b[A")) { dialog.highlighted = Math.max(0, dialog.highlighted - 1); redraw(); rawBuffer = ""; }
    else if (rawBuffer.includes("\x1b[B")) { dialog.highlighted = Math.min(OPTIONS.length - 1, dialog.highlighted + 1); redraw(); rawBuffer = ""; }
    else if (rawBuffer.includes("\r")) { const i = dialog.highlighted; rawBuffer = ""; selectOption(i); }
    else if (rawBuffer.startsWith("\x1b") && rawBuffer.length < 8) { /* wait for the rest of the sequence */ }
    else rawBuffer = "";
    return;
  }
  lineBuffer += chunk;
  let nl: number;
  while ((nl = lineBuffer.search(/[\r\n]/)) >= 0) {
    const line = lineBuffer.slice(0, nl).replace(/\x1b\[(200|201)~/g, "");
    lineBuffer = lineBuffer.slice(nl + 1);
    if (awaitingYesNo && /^[yY]$/.test(line)) { awaitingYesNo = false; console.log("\nContinuing.\n"); process.stdout.write("> "); continue; }
    if (awaitingYesNo && /^[nN]$/.test(line)) { awaitingYesNo = false; console.log("\nCancelled.\n"); process.stdout.write("> "); continue; }
    console.log(`\nYou: ${line}\nRehearsal: message received by process ${process.pid}.\n`);
    process.stdout.write("> ");
  }
});

if (request.includes("dialog")) setTimeout(() => openDialog(), 2000);
else if (request.includes("yesno")) setTimeout(() => { awaitingYesNo = true; process.stdout.write("Installing 3 packages\nContinue? [y/N] "); }, 2000);
else {
  let tick = 0;
  setInterval(() => console.log(`[${new Date().toISOString()}] Checkpoint ${++tick} · process still running`), 3000);
}
process.on("SIGTERM", () => { console.log("Rehearsal stopped."); process.exit(0); });
