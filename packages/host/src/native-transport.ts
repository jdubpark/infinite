import type { WebSocket } from "ws";

// Provider startup catalogs can exceed 12 MB. Bound individual messages and
// queued output separately, allowing a short burst of catalog responses.
export const NATIVE_MAX_MESSAGE = 32 * 1024 * 1024;
export const NATIVE_MAX_BUFFERED = 64 * 1024 * 1024;

// Compress only the cloud hop. Local provider sockets avoid repeated compression
// work; independent message contexts keep memory bounded across attachments.
export const NATIVE_COMPRESSION = {
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  zlibDeflateOptions: { level: 3 },
  concurrencyLimit: 2,
};

const CATALOG_CHUNK_BYTES = 64 * 1024;

// Only catalog read responses may be overtaken. Turn events, approval requests,
// and all other provider messages retain their original ordering.
export function nativeCatalogSender(socket: WebSocket, fail: () => void) {
  const queue: { id: number; data: Buffer; offset: number }[] = [];
  let nextId = 0, bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    const current = queue[0];
    if (!current) return;
    const end = Math.min(current.offset + CATALOG_CHUNK_BYTES, current.data.length);
    const frame = Buffer.allocUnsafe(12 + end - current.offset);
    frame.writeUInt32BE(current.id, 0);
    frame.writeUInt32BE(current.offset, 4);
    frame.writeUInt32BE(current.data.length, 8);
    current.data.copy(frame, 12, current.offset, end);
    current.offset = end;
    timer = setTimeout(fail, 20000);
    socket.send(frame, { binary: true }, error => { if (error) fail(); });
  };
  return {
    send(text: string) {
      const data = Buffer.from(text);
      if (data.length > NATIVE_MAX_MESSAGE || bytes + data.length > NATIVE_MAX_BUFFERED) throw new Error("Native catalog queue is full");
      bytes += data.length;
      queue.push({ id: nextId = (nextId + 1) >>> 0, data, offset: 0 });
      if (queue.length === 1) next();
    },
    acknowledge(frame: Buffer) {
      const current = queue[0];
      if (frame.length !== 8 || !current || frame.readUInt32BE(0) !== current.id || frame.readUInt32BE(4) !== current.offset) throw new Error("Invalid native catalog acknowledgement");
      clearTimeout(timer);
      if (current.offset === current.data.length) { bytes -= current.data.length; queue.shift(); }
      next();
    },
    close() { clearTimeout(timer); queue.length = 0; bytes = 0; },
  };
}

export function nativeCatalogReceiver(socket: WebSocket, deliver: (text: string) => void) {
  let current: { id: number; data: Buffer; offset: number } | undefined;
  return (frame: Buffer) => {
    if (frame.length <= 12 || frame.length > CATALOG_CHUNK_BYTES + 12) throw new Error("Invalid native catalog chunk");
    const id = frame.readUInt32BE(0), offset = frame.readUInt32BE(4), total = frame.readUInt32BE(8);
    if (!current) {
      if (offset !== 0 || total > NATIVE_MAX_MESSAGE || total === 0) throw new Error("Invalid native catalog size");
      current = { id, data: Buffer.allocUnsafe(total), offset: 0 };
    }
    if (id !== current.id || total !== current.data.length || offset !== current.offset || offset + frame.length - 12 > total) throw new Error("Invalid native catalog sequence");
    frame.copy(current.data, offset, 12);
    current.offset += frame.length - 12;
    const ack = Buffer.allocUnsafe(8); ack.writeUInt32BE(id, 0); ack.writeUInt32BE(current.offset, 4);
    if (current.offset === total) { deliver(current.data.toString("utf8")); current = undefined; }
    socket.send(ack, { binary: true });
  };
}
