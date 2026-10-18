// Scripted agent for tests/worker-attention.test.ts. It draws a Codex-style screen whose last
// non-empty row is a status row ending in "usage limited". Later it prints one unrelated body
// line (status row still last), then clears the screen for five seconds and draws the row again.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STATUS = "  gpt-5-codex · ~/workspace · usage limited";
console.log(["", "  The usage limit applies to this workspace.", "  Request failed: model overloaded, try again later.", "", STATUS].join("\n"));
await sleep(3500);
console.log(["  Unrelated progress line.", STATUS].join("\n"));
await sleep(2500);
process.stdout.write("\x1b[2J\x1b[H");
await sleep(5000);
console.log(["", "  The usage limit applies to this workspace.", "", STATUS].join("\n"));
setInterval(() => {}, 1000);
