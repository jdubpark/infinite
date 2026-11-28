import { appendFileSync, readdirSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.PERMISSION_FIXTURE_MODE ?? "decide";
if (argv[0] === "--version") { process.stdout.write(`${process.env.PERMISSION_FIXTURE_VERSION ?? "1.19.6"}\n`); process.exit(0); }
const second = argv.includes("--standalone");
const opencode = argv.includes("--pure") || second;
const stdin = opencode ? "" : (() => { try { return readFileSync(0, "utf8"); } catch { return ""; } })();

if (process.env.PERMISSION_FIXTURE_LOG) {
  appendFileSync(process.env.PERMISSION_FIXTURE_LOG, `${JSON.stringify({
    provider: opencode ? "opencode" : "claude", argv, env: Object.keys(process.env).sort(),
    openCodeConfig: process.env.OPENCODE_CONFIG_CONTENT ?? null, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), stdinBytes: stdin.length,
  })}\n`);
}

const print = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const option = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };

function evidenceOf(prompt) {
  const match = /<<<UNTRUSTED EVIDENCE ([0-9a-f]+)>>>\n([\s\S]*)\n<<<END UNTRUSTED EVIDENCE \1>>>/.exec(prompt);
  try { return match ? JSON.parse(match[2]) : {}; } catch { return {}; }
}

function decide(system, prompt) {
  const evidence = evidenceOf(prompt);
  const text = JSON.stringify(evidence);
  if (/You are the light tier/.test(system)) {
    return ["Read", "Grep", "Glob"].includes(evidence.request?.tool) ? { verdict: "allow", note: "A read inside the session root." } : { verdict: "refer", note: "Not a plain read." };
  }
  const canCollect = /"evidence" with "paths"/.test(system);
  const canAllow = /"allow" with "noInterruptClass"/.test(system);
  if (canCollect && /scripts\/[\w.-]+/.test(evidence.task?.text ?? "") && !evidence.collectedFiles)
    return { verdict: "evidence", paths: [/scripts\/[\w.-]+/.exec(evidence.task.text)[0]], note: "The verdict depends on the script." };
  if (canAllow && /ALLOW THIS/.test(text)) return { verdict: "allow", noInterruptClass: true, note: "The evidence says to allow it." };
  if (canAllow && /^(?:npm (?:test|run (?:lint|build))|node --test)\b/.test(evidence.request?.action ?? "")) return { verdict: "allow", noInterruptClass: true, note: "A routine check." };
  return { verdict: "reject", code: "uncertain", note: "Not sure." };
}

if (opencode) {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
  const agent = second ? config.agents?.["infinite-permission-review"] : config.agent?.["infinite-permission-review"];
  if (argv.includes("debug")) {
    if (second) {
      const permissions = mode === "tools-on" ? [{ action: "*", resource: "*", effect: "allow" }] : agent?.permissions ?? [];
      process.stdout.write(`${JSON.stringify([{ id: "build", permissions: [] }, { id: "infinite-permission-review", permissions }], null, 2)}\n`);
      process.exit(agent ? 0 : 1);
    }
    const tools = mode === "tools-on" ? { bash: true, read: false } : { bash: false, read: false, edit: false };
    process.stdout.write(`${JSON.stringify({ name: "infinite-permission-review", mode: agent?.mode ?? "primary", tools }, null, 2)}\n`);
    process.exit(agent ? 0 : 1);
  }
  const system = (second ? agent?.system : agent?.prompt) ?? "";
  const prompt = argv[argv.indexOf("--") + 1] ?? "";
  print({ type: "step_start", part: { type: "step-start" } });
  if (mode === "tool-use") print({ type: "tool_use", part: { tool: "bash", callID: "call-1", state: { status: "completed" } } });
  const report = mode === "bad-report" ? { verdict: "allow", note: "No class field.", extra: true } : decide(system, prompt);
  print({ type: "text", part: { type: "text", text: JSON.stringify(report) } });
  print({ type: "step_finish", part: { type: "step-finish", tokens: { input: 120, output: 12, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.0001 } });
  process.exit(0);
}

const system = option("--system-prompt") ?? "";
const tools = mode === "extra-tools" ? ["Bash", "StructuredOutput"] : ["StructuredOutput"];
print({ type: "system", subtype: "init", model: option("--model") ?? "unknown", tools, mcp_servers: [] });
if (mode === "tool-use") print({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "true" } }] } });
const report = mode === "bad-report" ? { verdict: "owner", note: "Not a class." } : decide(system, stdin);
print({ type: "assistant", message: { content: [{ type: "tool_use", name: "StructuredOutput", input: report }] } });
print({ type: "result", subtype: "success", is_error: false, structured_output: report, usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: 0.0002 });
