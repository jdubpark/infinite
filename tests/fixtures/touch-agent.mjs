// Scripted agent for tests/swarm-context-routes.test.ts. It posts tool hooks the way Claude Code does:
// two reads of one file, an edit, a read outside its working directory, and a graph query. Then it waits.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let count = 0;
const tool = (tool_name, tool_input) =>
  fetch(`${process.env.INFINITE_HOOK_URL}/claude`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}` },
    body: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: `t${++count}` }),
  }).catch(() => {});

await sleep(300);
await tool("Read", { file_path: `${process.cwd()}/src/app.ts` });
await tool("Read", { file_path: `${process.cwd()}/src/app.ts` });
await tool("Edit", { file_path: "src/lib/http.ts", old_string: "a", new_string: "b" });
await tool("Read", { file_path: "/etc/hosts" });
await tool("Bash", { command: "graphify query routes --graph out/graph.json" });
console.log("touched");
setInterval(() => {}, 1000);
