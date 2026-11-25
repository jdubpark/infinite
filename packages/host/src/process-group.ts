import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { EXIT_DRAIN_MS } from "./team-workspace.js";

const DRAIN_TURNS = 3;

export type GroupSignal = "sent" | "leader-exited" | "refused";
export type LeaderWatch = { readonly leftover: boolean };

export function leaderExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function signalGroup(child: ChildProcess, signal: NodeJS.Signals): GroupSignal {
  if (leaderExited(child)) return "leader-exited";
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM" ? "refused" : "leader-exited";
  }
  return "sent";
}

export function watchLeader(child: ChildProcess): LeaderWatch {
  const watch = { leftover: false };
  const outputs = [child.stdout, child.stderr].filter(stream => stream !== null) as Socket[];
  const held = () => outputs.filter(stream => !stream.readableEnded && !stream.destroyed);
  const read = () => outputs.reduce((total, stream) => total + stream.bytesRead, 0);
  let timer: NodeJS.Timeout | undefined;
  const drain = () => {
    timer = setTimeout(() => setImmediate(decide, 1, read()), EXIT_DRAIN_MS);
    timer.unref();
  };
  const decide = (turn: number, seen: number) => {
    const open = held();
    if (!open.length) return;
    if (open.some(stream => stream.readableFlowing === false)) {
      drain();
      return;
    }
    if (read() !== seen && turn < DRAIN_TURNS) {
      setImmediate(decide, turn + 1, read());
      return;
    }
    watch.leftover = true;
    child.stdin?.destroy();
    for (const stream of open) stream.destroy();
  };
  child.once("exit", drain);
  child.once("close", () => clearTimeout(timer));
  return watch;
}

export const GROUP_SUPERVISOR = `
  const {spawn}=require('node:child_process');
  const child=spawn(process.argv[1],process.argv.slice(2),{detached:true,stdio:['ignore','pipe','pipe']});
  let stopping=false;
  const kill=signal=>{if(child.pid&&child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid,signal)}catch{}};
  const stop=()=>{if(stopping)return;stopping=true;kill('SIGTERM');setTimeout(()=>{kill('SIGKILL');process.exit(1)},2000)};
  process.on('exit',()=>kill('SIGKILL'));
  process.stdout.on('error',stop);process.stderr.on('error',stop);
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  process.stdin.resume();process.stdin.on('end',stop);process.stdin.on('error',stop);
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,stop);
  child.on('error',()=>process.exit(1));
  child.on('exit',code=>process.exit(code??1));
`;
