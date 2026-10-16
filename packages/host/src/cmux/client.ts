import { execFile } from "node:child_process";

export class CmuxError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "CmuxError";
  }
}

/** No shell is involved. A failed mutation is never automatically retried. */
export function execute(command: string, args: string[], timeout = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        const code = /^Error:\s*([a-z][a-z0-9_]*):/m.exec(stderr || stdout)?.[1];
        reject(new CmuxError(code ?? "cmux-unavailable", "cmux did not confirm the operation"));
      }
      else resolve(stdout);
    });
  });
}

export type Json = Record<string, any>;
export const object = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
export const array = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
export const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

export interface Surface {
  id: string;
  workspaceId: string;
  title: string;
  type: string;
  tty?: string;
}

export class CmuxClient {
  constructor(readonly command: string) {}

  async rpc(method: string, params: Json = {}): Promise<Json> {
    const raw = await execute(this.command, ["rpc", method, JSON.stringify(params)]);
    let value: Json;
    try { value = object(JSON.parse(raw)); }
    catch { throw new CmuxError("cmux-unavailable", "cmux returned an invalid response"); }
    // CLI versions either return the result or the socket response envelope.
    if (value.ok === false) throw new CmuxError(string(value.error?.code) ?? "cmux-error", "cmux refused the operation");
    return value.ok === true && value.result !== undefined ? object(value.result) : value;
  }

  async tree(): Promise<Map<string, Surface>> {
    const raw = await this.rpc("system.tree", { all: true });
    if (!Array.isArray(raw.windows)) throw new CmuxError("cmux-unavailable", "cmux returned no workspace tree");
    const surfaces = new Map<string, Surface>();
    for (const window of array(raw.windows)) for (const workspace of array(window.workspaces)) {
      const workspaceId = string(workspace.id);
      if (!workspaceId) continue;
      for (const pane of array(workspace.panes)) for (const surface of array(pane.surfaces)) {
        const id = string(surface.id);
        if (id) surfaces.set(id, { id, workspaceId, title: string(surface.title) ?? string(workspace.title) ?? "cmux session", type: string(surface.type) ?? "terminal", tty: string(surface.tty) });
      }
    }
    return surfaces;
  }
}
