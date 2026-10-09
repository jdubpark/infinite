#!/usr/bin/env node
import { handleClientCommand } from "./client.js";

// The installed bundle is also the detached service entrypoint. Its private
// IPC bootstrap is handled by laptop-service, not by the interactive parser.
if (!(process.argv[2] === "--laptop-service" && process.send) && !await handleClientCommand(process.argv.slice(2))) {
  console.log(`Infinite — cloud sessions in your native terminal

infinite pair https://HOST --token-file FILE
infinite claude|codex|grok|opencode [native flags and prompt]
infinite --project ID --title "Task" codex [native flags]
infinite --detach codex [native flags]
infinite [--include DIR] codex ["Initial prompt"]
infinite --cloud codex [native flags and prompt]
infinite --local-ui codex [supported native flags] "Initial prompt"
infinite --local-ui opencode [--model PROVIDER/MODEL] [--prompt "Task"]
infinite list [--json]
infinite projects
infinite resume [session ID or unique prefix]
infinite monitor [session ID or unique prefix]
infinite recover SESSION_ID [--output NEW_DIRECTORY]

Put Infinite options before the provider. Everything after it is passed unchanged.
Codex uses the invoking laptop directory by default; --cloud opts out.
The laptop executor stays available after CLI exit.
Native resume IDs belong to the cloud conversation.
Ctrl+] detaches; Ctrl+G monitors; Enter in monitor mode enables input.
Ctrl+E opens a local draft; Ctrl+S inserts it; Enter in the native UI submits it.
Drafts recover after restart. Esc keeps the draft; Ctrl+X discards it.
A viewer key remains read-only. Reconnecting never starts another agent.
Local UI supports Codex (initial prompt required) and OpenCode experimentally.
Resume reopens the existing cloud conversation in its local native interface.
Use --takeover before resume to explicitly take control from another device.
The Ctrl+] / Ctrl+G / Ctrl+E shortcuts above apply to streamed terminal mode.

Client settings: ~/.config/infinite/client.json (or --client-config FILE).`);
  if (process.argv[2] && !["help", "--help", "-h"].includes(process.argv[2])) process.exitCode = 1;
}
