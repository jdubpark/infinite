// Scripted agent for tests/worker-attention.test.ts. It draws a Codex-style screen whose last
// non-empty row is a status row ending in "usage limited", then prints nothing more.
console.log(["", "  The usage limit applies to this workspace.", "  Request failed: model overloaded, try again later.", "", "  gpt-5-codex · ~/workspace · usage limited"].join("\n"));
setInterval(() => {}, 1000);
