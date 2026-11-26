import { readSync } from "node:fs";
import { Socket } from "node:net";
import type { IPty } from "node-pty";

const DRAIN_LIMIT = 1024 * 1024;

export function drainDescriptor(fd: number): { data: Buffer; closed: boolean } {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  for (let total = 0; total < DRAIN_LIMIT;) {
    let read: number;
    try {
      read = readSync(fd, buffer, 0, buffer.length, null);
    } catch (error) {
      return { data: Buffer.concat(chunks), closed: (error as NodeJS.ErrnoException).code === "EIO" };
    }
    if (read === 0) return { data: Buffer.concat(chunks), closed: true };
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    total += read;
  }
  return { data: Buffer.concat(chunks), closed: false };
}

export function trackPtyTail(pty: IPty, deliver: (data: string) => void): () => boolean {
  if (process.platform === "win32") return () => false;
  const { _socket: socket, _fd: fd } = pty as unknown as { _socket?: unknown; _fd?: unknown };
  if (!(socket instanceof Socket) || typeof fd !== "number") return () => true;
  let closed: boolean | undefined;
  socket.once("end", () => {
    const drained = drainDescriptor(fd);
    closed = drained.closed;
    if (drained.data.length) deliver(drained.data.toString("utf8"));
  });
  return () => !(closed ?? (socket.errored as NodeJS.ErrnoException | null)?.code === "EIO");
}

export function ptyTails(first: IPty, deliver: (data: string) => void) {
  const incomplete = [trackPtyTail(first, deliver)];
  return {
    track(pty: IPty) { incomplete.push(trackPtyTail(pty, deliver)); },
    marker: (): { outputTailIncomplete?: true } => (incomplete.some(check => check()) ? { outputTailIncomplete: true } : {}),
  };
}
