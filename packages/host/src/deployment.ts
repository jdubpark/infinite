import { z } from "zod";

const tenantId = z.uuid().transform((value) => value.toLowerCase());

const deploymentSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("single-tenant") }).strict(),
    z.object({ mode: z.literal("personal") }).strict(),
    z.object({ mode: z.literal("tenant-development"), tenantId }).strict(),
    z.object({ mode: z.literal("confidential"), tenantId }).strict(),
  ])
  .transform((value) =>
    value.mode === "personal" ? { mode: "single-tenant" as const } : value,
  );

export type Deployment = z.infer<typeof deploymentSchema>;

export function parseDeployment(value: unknown): Deployment {
  const deployment = deploymentSchema.parse(value ?? { mode: "single-tenant" });
  if (deployment.mode === "confidential") {
    throw new Error(
      "Confidential execution is unavailable: this runner has no attestation and user-controlled key-release backend. Ordinary VMs cannot protect data from the operator.",
    );
  }
  return deployment;
}

export function runtimeSecurity(deployment?: Deployment) {
  const policy = parseDeployment(deployment);
  return {
    mode: policy.mode,
    tenancy: policy.mode === "single-tenant" ? "single-tenant" : "multi-tenant",
    isolation:
      policy.mode === "single-tenant"
        ? "none-required"
        : "external-vm-required",
    tenantId: policy.mode === "single-tenant" ? null : policy.tenantId,
    contextScope: "one-instance-one-tenant" as const,
    operatorConfidential: false,
    attestation: "unavailable" as const,
    dataPolicy:
      policy.mode === "tenant-development"
        ? "synthetic-only"
        : "owner-controlled",
  };
}

/** Deployment hygiene, not a defense against an operator who changes the binary. */
export function assertRunnerDeployment(config: {
  deployment?: Deployment;
  enableDemo: boolean;
  agents: object;
}) {
  const policy = parseDeployment(config.deployment);
  if (
    policy.mode === "tenant-development" &&
    (!config.enableDemo ||
      Object.keys(config.agents).some((provider) => provider !== "demo"))
  ) {
    throw new Error(
      "Tenant development accepts only the rehearsal provider; do not install private provider credentials on this backend.",
    );
  }
}
