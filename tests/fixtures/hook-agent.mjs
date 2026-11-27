const mode = process.argv.at(-1) ?? "";
const gateIndex = process.argv.indexOf("--gate");
const gateBase = gateIndex >= 0 ? process.argv[gateIndex + 1] : undefined;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gate = async (name) => {
  if (gateBase) await fetch(`${gateBase}/${name}`).catch(() => {});
};
const post = (body) =>
  fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}` },
    body: JSON.stringify(body),
  }).catch(() => {});
const permission = (command) => post({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } });

const HEADER = ["Bash command", "  rm -rf build", "", "Do you want to proceed?"];
const OPTIONS = mode === "dialog-first"
  ? ["Yes", "Yes, and don't ask again for rm commands", "No, and tell Claude what to do differently"]
  : ["Yes", "No"];
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
  const downs = chunk.match(/\x1b\[B/g)?.length ?? 0;
  const ups = chunk.match(/\x1b\[A/g)?.length ?? 0;
  if (downs || ups) {
    highlighted = Math.max(0, Math.min(OPTIONS.length - 1, highlighted + downs - ups));
    process.stdout.write(`\x1b[${OPTIONS.length}A` + rows().map((row) => `\x1b[2K${row}\n`).join(""));
    if (mode === "answer-race") raceHook = permission("rm -rf build");
  }
  if (chunk.includes("\r")) {
    await raceHook;
    if (mode === "expiring-lease") await gate("close-dialog");
    open = false;
    process.stdout.write(`\x1b[${HEADER.length + OPTIONS.length}A\x1b[J`);
    console.log(`Selected: ${OPTIONS[highlighted]}`);
    if (mode === "dialog-first") process.stdout.write("Tell Claude what to do differently:\n> ");
  }
});

if (mode === "expiring-lease") {
  draw();
} else if (mode === "dialog-first") {
  draw();
  if (gateBase) await gate("dialog-first-screen");
  else await sleep(300);
  await post({ hook_event_name: "UserPromptSubmit", prompt: "dialog-first" });
  await post({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build", description: "Remove the stale build directory" }, tool_use_id: "demo-1" });
  await permission("rm -rf build");
} else {
  await sleep(300);
  if (mode === "mismatch") {
    draw();
    if (gateBase) await gate("mismatch-screen");
    else await sleep(400);
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
    await permission("rm -rf build");
    await sleep(400);
    draw();
  } else if (mode === "rate-limit-notice-first") {
    console.log("You've hit your session limit · resets 3:45pm");
    if (gateBase) await gate("notice-first-screen");
    else await sleep(500);
    await post({ hook_event_name: "StopFailure", error: "rate_limit" });
    await sleep(200);
    await post({ hook_event_name: "StopFailure", error: "rate_limit" });
    if (gateBase) await gate("notice-first-done");
  } else if (mode === "rate-limit-then-stop") {
    console.log("You've hit your session limit · resets 3:45pm");
    await post({ hook_event_name: "StopFailure", error: "rate_limit" });
    if (gateBase) await gate("then-stop-corroborated");
    else await sleep(1500);
    await post({ hook_event_name: "Stop" });
  } else if (mode === "rate-limit" || mode === "rate-limit-blip") {
    await post({ hook_event_name: "StopFailure", error: "rate_limit" });
    if (mode === "rate-limit") {
      console.log("You've hit your session limit · resets 3:45pm");
    }
  } else if (mode === "denied") {
    await permission("rm -rf build");
    await sleep(300);
    await post({ hook_event_name: "PermissionDenied", tool_name: "Bash", tool_input: { command: "rm -rf build" }, reason: "Denied by policy" });
  }
}
setInterval(() => {}, 1000);
