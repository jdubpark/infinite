export type GaugePayload = {
  integration?: IntegrationGauge;
};

export type IntegrationGauge = {
  writers: number;
  staleBase?: boolean;
  changedPaths?: number;
  truncated?: true;
};

const MAX_WRITERS = 64;
const MAX_CHANGED_PATHS = 100000;

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
