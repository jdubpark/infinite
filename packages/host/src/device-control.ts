import { createHash } from "node:crypto";
import type { Config, ControlActor } from "./types.js";

export type PairedDevice = Config["tokens"][number];

// A copied device key may be used on multiple laptops. Bind control to the
// authenticated key AND one client instance, never to a client-supplied label.
export function controlActor(device: PairedDevice, instance: string): ControlActor {
  return {
    id: createHash("sha256").update(`${device.hash}\0${instance}`).digest("hex"),
    label: device.label.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, 120) || "Paired device",
  };
}
