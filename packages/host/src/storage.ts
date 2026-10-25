import { statfs } from "node:fs/promises";
import type { StorageFloor } from "./team-types.js";

/** Bytes and inodes of the filesystem holding `path`. Inodes run out long before bytes on volumes full of dependency trees. */
export type VolumeUsage = { path: string; totalBytes: number; availableBytes: number; totalInodes: number; availableInodes: number };

export async function volumeUsage(path: string): Promise<VolumeUsage> {
  const fs = await statfs(path);
  return { path, totalBytes: fs.blocks * fs.bsize, availableBytes: fs.bavail * fs.bsize, totalInodes: fs.files, availableInodes: fs.ffree };
}

/** Fraction of the volume in use, by whichever of bytes or inodes is scarcer. */
export function volumeFullness(usage: VolumeUsage): number {
  const bytes = usage.totalBytes > 0 ? 1 - usage.availableBytes / usage.totalBytes : 0;
  const inodes = usage.totalInodes > 0 ? 1 - usage.availableInodes / usage.totalInodes : 0;
  return Math.max(bytes, inodes);
}

/** Why a new workspace must not be created on this volume, or undefined when it keeps the floor. */
export function storageShortfall(usage: VolumeUsage, floor: StorageFloor): string | undefined {
  if (usage.totalInodes > 0 && usage.availableInodes < floor.inodes)
    return `The workspace volume has ${usage.availableInodes.toLocaleString("en-US")} free inodes; new runs need at least ${floor.inodes.toLocaleString("en-US")}. Remove finished workspaces or grow the volume.`;
  if (usage.availableBytes < floor.bytes)
    return `The workspace volume has ${Math.round(usage.availableBytes / 1024 ** 3)} GiB free; new runs need at least ${Math.round(floor.bytes / 1024 ** 3)} GiB. Remove finished workspaces or grow the volume.`;
  return undefined;
}
