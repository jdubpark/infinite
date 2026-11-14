import { readFileSync } from "node:fs";
import { availableParallelism, freemem, loadavg } from "node:os";
import type { Config } from "./types.js";

export interface HostReading { availableMemoryBytes: number; load1: number; cpus: number }
export type HostLoadProbe = () => HostReading;

const GiB = 2 ** 30;
export const HOST_LOAD_REASON_PREFIX = "Waiting for host capacity: ";

/** Linux reports MemAvailable, which counts reclaimable cache; other platforms fall back to free memory. */
function availableMemoryBytes() {
  if (process.platform === "linux") {
    const line = readFileSync("/proc/meminfo", "utf8").split("\n").find(item => item.startsWith("MemAvailable:"));
    const kib = line ? Number(line.split(/\s+/)[1]) : NaN;
    if (Number.isFinite(kib)) return kib * 1024;
  }
  return freemem();
}

export const readHostLoad: HostLoadProbe = () => ({
  availableMemoryBytes: availableMemoryBytes(),
  load1: loadavg()[0],
  cpus: availableParallelism(),
});

/** An automatic launch that the host's own load would make worse. Owner-started sessions never pass through this. */
export class LaunchHeldError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "LaunchHeldError";
  }
}

/** Only an empty reason or an earlier host-load hold may be replaced or cleared; any other reason belongs to its owner. */
export function holdsHostLoadReason(reason: string | undefined) {
  return reason === undefined || reason.startsWith(HOST_LOAD_REASON_PREFIX);
}

export class HostLoadGate {
  private checkedAt?: number;
  private current?: string;

  constructor(
    private readonly limits: Config["hostLoad"],
    private readonly probe: HostLoadProbe = readHostLoad,
    private readonly ttlMs = 2000,
  ) {}

  /** The reason automatic launches must wait, or undefined. Re-reads the host at most once per ttlMs. */
  held(): string | undefined {
    if (!this.limits) return undefined;
    const now = Date.now();
    if (this.checkedAt === undefined || now - this.checkedAt >= this.ttlMs) {
      this.checkedAt = now;
      try { this.current = this.reasonFor(this.probe()); }
      catch { this.current = undefined; }
    }
    return this.current;
  }

  private reasonFor(reading: HostReading): string | undefined {
    const limits = this.limits!;
    const memoryGiB = reading.availableMemoryBytes / GiB;
    if (memoryGiB < limits.minAvailableMemoryGiB)
      return `${HOST_LOAD_REASON_PREFIX}${memoryGiB.toFixed(1)} GiB of memory is available, below the ${limits.minAvailableMemoryGiB} GiB floor.`;
    if (reading.load1 / reading.cpus > limits.maxLoadPerCpu)
      return `${HOST_LOAD_REASON_PREFIX}load ${reading.load1.toFixed(1)} on ${reading.cpus} CPUs is above the ceiling of ${limits.maxLoadPerCpu} per CPU.`;
    return undefined;
  }
}
