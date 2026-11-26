import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export const SUPERVISOR_GRACE_MS = 2_000;

export const GROUP_ANCHOR = [
  "g=$1; s=; shift",
  "exec 3>&2 2>/dev/null",
  "trap 's=1' TERM",
  "(exec \"$@\" 2>&3 3>&-)",
  "c=$?",
  "trap '' TERM",
  "if [ -n \"$s\" ]; then { command -p sleep \"$g\"; kill -s KILL 0; } </dev/null >/dev/null 2>&1 3>&- & fi",
  "trap - TERM",
  "if [ \"$c\" -gt 128 ] && n=$(kill -l \"$c\"); then",
  "  case $n in STOP|TSTP|TTIN|TTOU) ;; *) ulimit -c 0; kill -s \"$n\" $$ ;; esac",
  "fi",
  "exit \"$c\"",
].join("\n");

export const TEAM_ANCHOR = [
  "g=$1; s=; shift",
  "exec 3>&2 2>/dev/null 4<&0",
  "if env --default-signal=INT,QUIT true >/dev/null 2>&1; then set -- env --default-signal=INT,QUIT \"$@\"; fi",
  "trap 'if [ -z \"$s\" ]; then s=1; kill -s TERM 0; { command -p sleep \"$g\"; kill -s KILL 0; } </dev/null >/dev/null 2>&1 3>&- 4<&- & fi' TERM",
  "\"$@\" <&4 2>&3 3>&- 4<&- &",
  "p=$!",
  "exec 4<&-",
  "while :; do",
  "  wait \"$p\"; c=$?",
  "  kill -0 \"$p\" 2>/dev/null || break",
  "done",
  "trap - TERM",
  "if [ \"$c\" -gt 128 ] && n=$(kill -l \"$c\"); then",
  "  case $n in STOP|TSTP|TTIN|TTOU) ;; *) ulimit -c 0; kill -s \"$n\" $$ ;; esac",
  "fi",
  "exit \"$c\"",
].join("\n");

export function teamAnchored(command: { command: string; args: string[] }, graceMs: number): { command: string; args: string[] } {
  return { command: "sh", args: ["-c", TEAM_ANCHOR, "sh", String(Math.ceil(graceMs / 1000)), command.command, ...command.args] };
}

export const GROUP_SUPERVISOR = `
  const {spawn}=require('node:child_process');
  const child=spawn(process.argv[1],process.argv.slice(2),{detached:true,stdio:['ignore','pipe','pipe']});
  let stopping=false;
  const kill=signal=>{if(child.pid&&child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,signal)}catch{}};
  const stop=()=>{if(stopping)return;stopping=true;kill('SIGTERM');setTimeout(()=>{kill('SIGKILL');process.exit(1)},${SUPERVISOR_GRACE_MS})};
  process.on('exit',()=>kill('SIGKILL'));
  process.stdout.on('error',stop);process.stderr.on('error',stop);
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  process.stdin.resume();process.stdin.on('end',stop);process.stdin.on('error',stop);
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,stop);
  child.on('error',()=>process.exit(1));
  child.on('exit',code=>process.exit(code??1));
`;

type Placement = { cwd?: string; env?: NodeJS.ProcessEnv };

function executable(command: string, cwd: string, path: string): string | undefined {
  const candidates = command.includes("/") ? [resolve(cwd, command)] : path.split(delimiter).map(directory => resolve(cwd, directory, command));
  return candidates.find(candidate => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export function anchoredCommand(command: string, args: readonly string[], placement: Placement, graceMs: number): [string, string[]] {
  const found = process.platform === "win32" ? undefined : executable(command, placement.cwd ?? process.cwd(), (placement.env ?? process.env).PATH ?? "/usr/bin:/bin");
  return found === undefined ? [command, [...args]] : ["/bin/sh", ["-c", GROUP_ANCHOR, "sh", String(Math.ceil(graceMs / 1000)), found, ...args]];
}

export function supervisorArgs(command: string, args: readonly string[], placement: Placement): string[] {
  const [file, argv] = anchoredCommand(command, args, placement, SUPERVISOR_GRACE_MS);
  return ["-e", GROUP_SUPERVISOR, file, ...argv];
}
