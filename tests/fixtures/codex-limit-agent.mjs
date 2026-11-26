const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gateIndex = process.argv.indexOf("--gate");
const gateBase = gateIndex >= 0 ? process.argv[gateIndex + 1] : undefined;
const step = async (name, fallbackMs) => {
  if (gateBase) await fetch(`${gateBase}/${name}`).catch(() => {});
  else await sleep(fallbackMs);
};
const STATUS = "  gpt-5-codex · ~/workspace · usage limited";
console.log(["", "  The usage limit applies to this workspace.", "  Request failed: model overloaded, try again later.", "", STATUS].join("\n"));
await step("progress", 4500);
console.log(["  Unrelated progress line.", STATUS].join("\n"));
await step("osc", 1500);
process.stdout.write("\x1b]9;turn complete\x07");
await step("clear", 3000);
process.stdout.write("\x1b[2J\x1b[H");
await step("reopen", 5000);
console.log(["", "  The usage limit applies to this workspace.", "", STATUS].join("\n"));
setInterval(() => {}, 1000);
