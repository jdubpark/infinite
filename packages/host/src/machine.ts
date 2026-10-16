import { createHash } from "node:crypto";
import type { Config } from "./types.js";

/** Legacy hosts gain an opaque stable identity without exposing paths or hostnames. */
export function machineIdentity(config: Config, key: Buffer) {
  if (config.machine) return config.machine;
  const bytes = createHash("sha256").update("infinite:machine:v1").update(key).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x40;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex");
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    label: config.environment === "cloud" ? "Cloud host" : "Local machine",
  };
}
