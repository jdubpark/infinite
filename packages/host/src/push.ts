import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unseal, writeSealed } from "./vault.js";

export interface PushDevice { deviceId: string; token: string; platform: "android" | "ios"; addedAt: string }
export interface PushMessage { to: string; title: string; body: string; data: { url: string }; channelId: "attention"; priority: "high" | "default"; collapseId: string }
export interface PushTicket { status: "ok" | "error"; id?: string; message?: string; details?: { error?: string } }
export type PushSender = (messages: PushMessage[]) => Promise<PushTicket[]>;

export class PushStore {
  private readonly file: string;
  constructor(stateDir: string, private readonly key: Buffer) { this.file = join(stateDir, "push-devices.sealed"); }
  list(): PushDevice[] {
    return existsSync(this.file) ? unseal<PushDevice[]>(this.key, "push-devices", readFileSync(this.file, "utf8")) : [];
  }
  private save(devices: PushDevice[]) { writeSealed(this.file, this.key, "push-devices", devices); }
  add(deviceId: string, token: string, platform: "android" | "ios") {
    const devices = this.list().filter((d) => d.token !== token);
    devices.push({ deviceId, token, platform, addedAt: new Date().toISOString() });
    this.save(devices);
  }
  remove(token: string) { this.save(this.list().filter((d) => d.token !== token)); }
}

export const isExpoToken = (token: string) => /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,}\]$/.test(token);

export function expoSender(opts: { endpoint: string; accessToken?: string }): PushSender {
  return async (messages) => {
    const tickets: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      try {
        const response = await fetch(opts.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", ...(opts.accessToken ? { Authorization: `Bearer ${opts.accessToken}` } : {}) },
          body: JSON.stringify(chunk),
          signal: AbortSignal.timeout(10000),
        });
        const json = (await response.json()) as { data?: PushTicket[] };
        if (Array.isArray(json.data) && json.data.length === chunk.length) tickets.push(...json.data);
        else tickets.push(...chunk.map(() => ({ status: "error" as const, message: Array.isArray(json.data) ? "unexpected ticket count" : `HTTP ${response.status}` })));
      } catch (error) {
        tickets.push(...chunk.map(() => ({ status: "error" as const, message: (error as Error).message })));
      }
    }
    return tickets;
  };
}
