#!/usr/bin/env node
import { handleClientCommand } from "./client.js";

if (!await handleClientCommand(process.argv.slice(2))) {
  console.log(`Infinite — cloud sessions in your native terminal

infinite pair https://HOST --token-file FILE
infinite claude|codex|grok|opencode [native flags and prompt]
infinite --project ID --title "Task" codex [native flags]
infinite --detach codex [native flags]
infinite list [--json]
infinite projects
infinite resume [session ID or unique prefix]
infinite monitor [session ID or unique prefix]

Put Infinite options before the provider. Everything after it is passed unchanged.
Paths and native resume IDs belong to the cloud host.
Ctrl+] detaches; Ctrl+G monitors; Enter in monitor mode enables input.
Ctrl+E opens a local draft; Ctrl+S inserts it; Enter in the native UI submits it.
A viewer key remains read-only. Reconnecting never starts another agent.

Client settings: ~/.config/infinite/client.json (or --client-config FILE).`);
  if (process.argv[2] && !["help", "--help", "-h"].includes(process.argv[2])) process.exitCode = 1;
}
