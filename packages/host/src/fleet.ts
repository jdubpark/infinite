import { z } from "zod";

const tenantSchema = z
  .object({
    tenantId: z.uuid().transform((value) => value.toLowerCase()),
    vmId: z.number().int().min(100).max(999999999),
    ipv4: z.ipv4(),
    memoryMiB: z.number().int().min(2048).max(65536),
    vcpus: z.number().int().min(1).max(16),
    diskGiB: z.number().int().min(16).max(800),
    diskReadMBps: z.number().int().min(1).max(1000),
    diskWriteMBps: z.number().int().min(1).max(1000),
    maxSessions: z.number().int().min(1).max(24),
    dataClass: z.enum(["synthetic", "private"]),
  })
  .strict();

const fleetSchema = z
  .object({
    provider: z.literal("proxmox-development"),
    hostMemoryMiB: z.literal(65536),
    reserveMemoryMiB: z.number().int().min(8192).max(32768),
    guestVcpuBudget: z.number().int().min(1).max(16),
    guestDiskBudgetGiB: z.number().int().min(16).max(800),
    managementCidrs: z.array(z.cidrv4()).min(1),
    tenants: z.array(tenantSchema).min(1).max(8),
  })
  .strict();

/** Secret-free capacity plan. This does not provision VMs or establish isolation. */
export function planFleet(input: unknown) {
  const fleet = fleetSchema.parse(input);
  for (const field of ["tenantId", "vmId", "ipv4"] as const) {
    if (
      new Set(fleet.tenants.map((tenant) => tenant[field])).size !==
      fleet.tenants.length
    ) {
      throw new Error(`Each tenant needs a unique ${field}`);
    }
  }
  if (fleet.tenants.some((tenant) => tenant.dataClass !== "synthetic")) {
    throw new Error(
      "Private workloads are blocked: this development backend has no operator-confidential execution.",
    );
  }
  const totalMemoryMiB = fleet.tenants.reduce(
    (sum, tenant) => sum + tenant.memoryMiB,
    0,
  );
  const totalVcpus = fleet.tenants.reduce(
    (sum, tenant) => sum + tenant.vcpus,
    0,
  );
  const totalDiskGiB = fleet.tenants.reduce(
    (sum, tenant) => sum + tenant.diskGiB,
    0,
  );
  if (totalMemoryMiB + fleet.reserveMemoryMiB > fleet.hostMemoryMiB)
    throw new Error(
      "Guest memory exceeds the host budget after its reservation",
    );
  if (totalVcpus > fleet.guestVcpuBudget)
    throw new Error("Guest vCPUs exceed the declared budget");
  if (totalDiskGiB > fleet.guestDiskBudgetGiB)
    throw new Error("Guest disks exceed the declared storage budget");

  return {
    schemaVersion: 1,
    status: "development-plan-not-provisioned",
    provider: fleet.provider,
    operatorConfidential: false,
    privateWorkloadsAllowed: false,
    memory: {
      guestsMiB: totalMemoryMiB,
      reservedMiB: fleet.reserveMemoryMiB,
      unallocatedMiB:
        fleet.hostMemoryMiB - totalMemoryMiB - fleet.reserveMemoryMiB,
    },
    vcpus: totalVcpus,
    disksGiB: totalDiskGiB,
    tenants: fleet.tenants.map((tenant) => ({
      tenantId: tenant.tenantId,
      vm: {
        id: tenant.vmId,
        name: `infinite-${tenant.vmId}`,
        isolation: "full-kvm-vm",
        guestOS: "ubuntu-24.04",
        memoryMiB: tenant.memoryMiB,
        vcpus: tenant.vcpus,
        cpuLimit: tenant.vcpus,
        ballooning: false,
        diskGiB: tenant.diskGiB,
        diskReadMBps: tenant.diskReadMBps,
        diskWriteMBps: tenant.diskWriteMBps,
        sharedWritableMounts: [],
        diskOwner: tenant.tenantId,
      },
      network: {
        ipv4: tenant.ipv4,
        enforcement: "hypervisor-required",
        ingress: "deny-by-default; tenant-authorized overlay access only",
        denyUnderlayCidrs: [
          ...new Set([
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "100.64.0.0/10",
            "169.254.0.0/16",
            ...fleet.managementCidrs,
          ]),
        ],
        ipv6Underlay: "deny",
        macAndIpSpoofing: "deny",
      },
      runner: {
        deployment: { mode: "tenant-development", tenantId: tenant.tenantId },
        maxSessions: tenant.maxSessions,
        providers: ["demo"],
        secrets:
          "initialize separately inside this guest; operator-readable in development",
      },
    })),
  };
}
