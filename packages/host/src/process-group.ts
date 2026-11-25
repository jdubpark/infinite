import type { ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import type { Readable } from "node:stream";
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

const isSocket = (stream: Readable | null): stream is Socket => stream instanceof Socket;

export function watchLeader(child: ChildProcess): LeaderWatch {
  const watch = { leftover: false };
  const outputs = [child.stdout, child.stderr].filter(isSocket);
  const held = () => outputs.filter(stream => !stream.readableEnded && !stream.destroyed);
  const paused = (open: Socket[]) => open.some(stream => stream.readableFlowing === false);
  const read = () => outputs.reduce((total, stream) => total + stream.bytesRead, 0);
  let timer: NodeJS.Timeout | undefined;
  const drain = () => {
    timer = setTimeout(() => {
      if (paused(held())) drain();
      else setImmediate(decide, 1, read());
    }, EXIT_DRAIN_MS);
    timer.unref();
  };
  const decide = (turn: number, seen: number) => {
    const open = held();
    if (!open.length) return;
    if (paused(open)) {
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
