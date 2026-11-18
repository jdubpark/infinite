/** Gauge fields of a sealed outcome payload. Numbers and flags only: never a path, a name, or text. */
export type GaugePayload = {
  /** Gauge 2 (INF-307): how concurrent one integration was. */
  integration?: IntegrationGauge;
};

export type IntegrationGauge = {
  /** Other tasks of the run with status `running` or `waiting` when this result was integrated. */
  writers: number;
  /**
   * True when the integration head had moved past this member's base before this integration. Absent when unknown.
   * It measures only that the head had moved past the base, not that two members ran at the same time. It is true for an
   * assignment that waited in the queue on an older base while another result landed, and a result with no commit can be
   * stale too. It is false for a member created after earlier integrations, even though other work had landed before it started.
   */
  staleBase?: boolean;
  /** Paths this result changed. Absent when the host could not read the list. */
  changedPaths?: number;
  /** Set when the path list was cut at its bound, so `changedPaths` is a lower bound. */
  truncated?: true;
};

const MAX_WRITERS = 64;
const MAX_CHANGED_PATHS = 100000;

/** Computes the gauge from run state the host already holds. Pure: no Git read, no clock, no path in the result. */
export function integrationGauge(input: {
  tasks: readonly { id: string; status: string }[];
  taskId: string;
  memberBase: string;
  headBefore: string | undefined;
  changedPaths: { paths: string[]; truncated: boolean } | undefined;
}): IntegrationGauge {
  const writers = input.tasks.filter(task => task.id !== input.taskId && (task.status === "running" || task.status === "waiting")).length;
  const gauge: IntegrationGauge = { writers };
  if (input.headBefore !== undefined && input.headBefore !== "") gauge.staleBase = input.headBefore !== input.memberBase;
  if (input.changedPaths) {
    gauge.changedPaths = input.changedPaths.paths.length;
    if (input.changedPaths.truncated) gauge.truncated = true;
  }
  return gauge;
}

/** Reads a gauge from stored event data. Keeps only the known keys with valid values; never throws. */
export function integrationOf(value: unknown): IntegrationGauge | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source: Record<string, unknown> = { ...value };
  const writers = source.writers;
  if (typeof writers !== "number" || !Number.isInteger(writers) || writers < 0 || writers > MAX_WRITERS) return undefined;
  const gauge: IntegrationGauge = { writers };
  if (typeof source.staleBase === "boolean") gauge.staleBase = source.staleBase;
  const changed = source.changedPaths;
  if (typeof changed === "number" && Number.isInteger(changed) && changed >= 0 && changed <= MAX_CHANGED_PATHS) gauge.changedPaths = changed;
  if (source.truncated === true) gauge.truncated = true;
  return gauge;
}
