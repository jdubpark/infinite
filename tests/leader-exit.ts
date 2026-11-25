import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const LEADER_LEAVES = resolve("tests/fixtures/leader-leaves.mjs");
export type LeftBehind = { leader: number; holder: number; witness: number };
export type Stubborn = { leader: number; member: number };

export function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function until(what: string, ready: () => boolean, limitMs = 10_000) {
  const deadline = Date.now() + limitMs;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`${what} within ${limitMs} ms`);
    await new Promise(done => setTimeout(done, 10));
  }
}

function recorded(record: string): Record<string, number> | undefined {
  const text = existsSync(record) ? readFileSync(record, "utf8") : "";
  return text.endsWith("\n") ? JSON.parse(text) as Record<string, number> : undefined;
}

export function leftBehind(record: string): LeftBehind | undefined {
  return recorded(record) as LeftBehind | undefined;
}

export async function stubbornMember(record: string): Promise<Stubborn> {
  await until("the leader records its member that ignores SIGTERM", () => recorded(record)?.member !== undefined);
  return recorded(record) as Stubborn;
}

export async function leaderGone(record: string): Promise<LeftBehind> {
  await until("the leader records what it leaves", () => leftBehind(record) !== undefined);
  const left = leftBehind(record)!;
  await until("the leader is reaped", () => gone(left.leader));
  return left;
}

export function endLeftBehind(record: string) {
  const left = Object.entries(recorded(record) ?? {}).filter(([role]) => role !== "leader");
  for (const [, pid] of left)
    if (Number.isSafeInteger(pid) && pid > 1 && !gone(pid)) process.kill(pid, "SIGKILL");
}

export async function within<T>(work: Promise<T>, limitMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what} within ${limitMs} ms` })), limitMs); });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
