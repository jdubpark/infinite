import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const LEADER_LEAVES = resolve("tests/fixtures/leader-leaves.mjs");
export type LeftBehind = { leader: number; holder: number; witness: number };

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

export function leftBehind(record: string): LeftBehind | undefined {
  const text = existsSync(record) ? readFileSync(record, "utf8") : "";
  return text.endsWith("\n") ? JSON.parse(text) as LeftBehind : undefined;
}

export async function leaderGone(record: string): Promise<LeftBehind> {
  await until("the leader records what it leaves", () => leftBehind(record) !== undefined);
  const left = leftBehind(record)!;
  await until("the leader is reaped", () => gone(left.leader));
  return left;
}

export function endLeftBehind(record: string) {
  const left = leftBehind(record);
  for (const pid of left ? [left.holder, left.witness] : [])
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
