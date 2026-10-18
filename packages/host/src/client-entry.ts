#!/usr/bin/env node
import { handleClientCommand } from "./client.js";

// The installed bundle is also the detached service entrypoint. Its private
// IPC bootstrap is handled by laptop-service or sync-service, not by the
// interactive parser.
if (!((process.argv[2] === "--laptop-service" || process.argv[2] === "--sync-service") && process.send) && !await handleClientCommand(process.argv.slice(2))) {
  console.log(`Infinite — cloud sessions in your native terminal

infinite pair https://HOST --token-file FILE
infinite cmux [native workspace/terminal commands]
infinite claude|codex|grok|opencode [native flags and prompt]
infinite --project ID --title "Task" codex [native flags]
infinite --detach codex [native flags]
infinite --laptop [--include DIR] codex ["Initial prompt"]
infinite --local-ui codex [supported native flags] "Initial prompt"
infinite --local-ui opencode [--model PROVIDER/MODEL] [--prompt "Task"]
infinite list [--json]
infinite resources [--watch] [--json]
infinite close SESSION_ID [--yes] [--takeover] [--json]
infinite projects
infinite resume [session ID or unique prefix]
infinite monitor [session ID or unique prefix]
infinite recover SESSION_ID [--output NEW_DIRECTORY]
infinite sync [--project ID] | --stop | --status | --apply [--force]
infinite pull [PROJECT_ID] [--output NEW_DIRECTORY]
infinite repo init [DIRECTORY] [--project ID] [--check-json JSON]
infinite repo init PARENT_DIRECTORY --linear-team UUID [--linear-project UUID]
infinite repo link PROJECT_OR_DIRECTORY --relationship "Uses its API"
infinite repo unlink PROJECT_OR_DIRECTORY | repo links
infinite team start [OBJECTIVE] [--prd FILE] [--provider PROVIDER]
infinite team status [ID] [--json] | team watch ID | team pull TEAM_ID [--json]
infinite team steer ID TEXT | team answer ID QUESTION_ID TEXT
infinite team pause|resume|cancel ID

Put Infinite options before the provider. Everything after it is passed unchanged.
Sessions run on the cloud machine. --laptop runs Codex tools in this directory with background cloud handoff.
The laptop executor stays available after CLI exit.
Sync keeps the cloud project current with this checkout, one way; pull downloads the cloud copy.
Native resume IDs belong to the cloud conversation.
Ctrl+] detaches; Ctrl+G monitors; Enter in monitor mode enables input.
Ctrl+E opens a local draft; Ctrl+S inserts it; Enter in the native UI submits it.
Drafts recover after restart. Esc keeps the draft; Ctrl+X discards it.
A viewer key remains read-only. Reconnecting never starts another agent.
Closing requires confirmation; --yes confirms noninteractive use. --takeover explicitly replaces another client's control.
Resources are timestamped; unavailable measurements remain unavailable. --watch refreshes every two seconds.
cmux opens the same separate cmux workspace catalog as the Mac app, using the installed infinite-cmux launcher.
Local UI supports Codex and OpenCode experimentally.
Only cloud Codex with --local-ui requires an initial prompt.
Resume reopens the existing cloud conversation in its local native interface.
Use --takeover before resume to explicitly take control from another device.
The Ctrl+] / Ctrl+G / Ctrl+E shortcuts above apply to streamed terminal mode.

Client settings: ~/.config/infinite/client.json (or --client-config FILE).`);
  if (process.argv[2] && !["help", "--help", "-h"].includes(process.argv[2])) process.exitCode = 1;
}
