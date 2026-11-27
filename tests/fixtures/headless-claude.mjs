import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const settings = JSON.parse(value("--settings") ?? "{}");
const resume = value("--resume");
const allowed = [];
for (let index = 0; index < args.length; index++)
  if (args[index] === "--allowedTools") while (index + 1 < args.length && !args[index + 1].startsWith("-")) allowed.push(args[++index]);
const prompt = resume ? "" : args.at(-1) ?? "";
const sessionId = resume ?? "fake-session-1";
const stateDir = join(process.cwd(), ".fake-claude");
const marker = join(stateDir, `${sessionId}.json`);
mkdirSync(stateDir, { recursive: true });

function runHook(command, payload, timeoutS) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutS * 1000);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function hooks(event, payload) {
  const outputs = [];
  for (const group of settings.hooks?.[event] ?? [])
    for (const hook of group.hooks ?? []) {
      const out = await runHook(hook.command, { hook_event_name: event, session_id: sessionId, cwd: process.cwd(), ...payload }, hook.timeout ?? 60);
      if (out) outputs.push(JSON.parse(out).hookSpecificOutput);
    }
  return outputs;
}

async function call(tool, input, id, agent) {
  const base = { tool_name: tool, tool_input: input, ...(agent ? { agent_id: agent, agent_type: "general-purpose" } : {}) };
  const pre = await hooks("PreToolUse", { ...base, tool_use_id: id });
  const decisions = pre.map((output) => output.permissionDecision);
  const reason = pre.find((output) => output.permissionDecisionReason)?.permissionDecisionReason;
  if (decisions.includes("deny")) return deny(tool, input, reason);
  if (decisions.includes("defer")) {
    if (agent) return "subagent-defer-ignored";
    writeFileSync(marker, JSON.stringify({ id, tool, input }));
    console.log(JSON.stringify({ type: "result", stop_reason: "tool_deferred", deferred_tool_use: { id, name: tool, input } }));
    return "deferred";
  }
  if (decisions.includes("allow")) return run(tool, input);
  if (tool === "Bash" && allowed.includes(`Bash(${input.command})`)) return run(tool, input);
  const request = await hooks("PermissionRequest", base);
  const decision = request.find((output) => output.decision)?.decision;
  if (decision?.behavior === "allow") return run(tool, input);
  return deny(tool, input, decision?.message ?? "print mode: no one to ask");
}
function run(tool, input) { appendFileSync(join(process.cwd(), "ran.log"), `${input.command ?? tool}\n`); return "ran"; }
function deny(tool, input, reason) { appendFileSync(join(process.cwd(), "denied.log"), `${input.command ?? tool}: ${reason}\n`); return "denied"; }

if (resume) {
  while (existsSync(join(process.cwd(), "hold-resume"))) await new Promise((done) => setTimeout(done, 50));
  if (!existsSync(marker)) {
    console.error("Error: No deferred tool marker found in the resumed session.");
    process.exit(1);
  }
  const deferred = JSON.parse(readFileSync(marker, "utf8"));
  rmSync(marker);
  const input = existsSync(join(process.cwd(), "change-on-resume")) ? { command: `${deferred.input.command} --and-more` } : deferred.input;
  await call(deferred.tool, input, deferred.id);
  await hooks("UserPromptSubmit", { prompt: "Continue from where you left off." });
  await hooks("Stop", {});
  process.exit(0);
}

const steps = {
  mixed: [["Bash", { command: "make safe-build" }, "toolu_safe"], ["Bash", { command: "rm -rf scratch" }, "toolu_unsafe"], ["Bash", { command: "deploy production" }, "toolu_prod"]],
  allowlisted: [["Bash", { command: "deploy production" }, "toolu_prod"]],
  subagent: [["Bash", { command: "deploy production" }, "toolu_sub", "agent-1"]],
}[prompt.split(" ")[0]] ?? [];
await hooks("UserPromptSubmit", { prompt });
for (const [tool, input, id, agent] of steps) {
  const result = await call(tool, input, id, agent);
  if (result === "deferred") process.exit(0);
}
await hooks("Stop", {});
process.exit(0);
