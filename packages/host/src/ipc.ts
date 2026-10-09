import { createConnection } from "node:net";
import { join } from "node:path";
import type { WorkerRequest } from "./types.js";
export const socketPath = (runDir: string, id: string) =>
  join(runDir, `${id}.sock`);
/** Error from a worker; `code` is set when the worker refused for a reason the client can act on. */
export type WorkerError = Error & { code?: string };
export function workerCall<T>(
  runDir: string,
  id: string,
  request: WorkerRequest,
  timeoutMs = 4000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(runDir, id));
    let data = "";
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(
        new Error("Worker response timed out; delivery may be uncertain"),
      ),
    );
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.length > (request.op === "workspace-export" ? 40 : 2) * 1024 * 1024)
        return socket.destroy(new Error("Oversized worker response"));
      const end = data.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(data.slice(0, end));
        socket.end();
        if (response.error) {
          const error: WorkerError = new Error(response.error);
          if (typeof response.code === "string") error.code = response.code;
          reject(error);
        } else resolve(response.result);
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (!data.includes("\n")) reject(new Error("Worker unavailable"));
    });
  });
}
