import { writeFileSync } from "node:fs";

const labels = ["No, start without it", "Yes, turn on Code Mode"];
const answerFile = process.env.CODE_MODE_DIALOG_ANSWER_FILE;
let highlighted = process.env.CODE_MODE_DIALOG_INITIAL === "Yes" ? 1 : 0;
let open = true;
const yesNo = process.env.CODE_MODE_DIALOG_LIVE === "yes-no";
let received = "";

function draw() {
  const oldMenu = process.env.CODE_MODE_DIALOG_OLD_COPY === "1"
    ? ["Code Mode (experimental)", "❯ No, start without it", "  Yes, turn on Code Mode", ""] : [];
  const dialog = [
    "Code Mode (experimental)",
    "",
    "  Code Mode runs JavaScript that calls Claude's tools.",
    "  This is an early experiment and may change in a future release.",
    "  Remote Control and computer use are off in Code Mode.",
    "",
    ...labels.map((label, index) => `  ${index === highlighted ? "❯ " : "  "}${label}`),
    "",
    "  Tell us how it goes with /feedback",
    "",
    "  Enter to confirm · Esc to start without it",
  ];
  const live = yesNo ? ["Press y to proceed or n to cancel [Y/n]"] : dialog;
  process.stdout.write(`\u001b[H\u001b[2J${[...oldMenu, ...live].join("\r\n")}\r\n`);
}

if (!answerFile) throw new Error("CODE_MODE_DIALOG_ANSWER_FILE is required");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  if (!open) return;
  if (yesNo) {
    received += chunk;
    if (!/[\r\n]/.test(chunk)) return;
    open = false;
    writeFileSync(answerFile, JSON.stringify(received));
    process.stdout.write(`\u001b[H\u001b[2JReceived keys\r\n`);
    return;
  }
  let moved = false;
  if (chunk.includes("\u001b[B") || chunk.includes("\u001b[A")) {
    highlighted = chunk.includes("\u001b[B") ? Math.min(1, highlighted + 1) : Math.max(0, highlighted - 1);
    moved = true;
  }
  if (chunk.includes("\r") || chunk.includes("\n")) {
    open = false;
    writeFileSync(answerFile, labels[highlighted]);
    process.stdout.write(`\u001b[H\u001b[2JSelected: ${labels[highlighted]}\r\n`);
  } else if (moved) draw();
});

draw();
setInterval(() => {}, 1000);
