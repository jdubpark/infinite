# Proxmox tenant development

This is an ordinary-VM development backend. It provides **no confidentiality from the host operator**. Use synthetic data only. No remote machine has been configured by these files. The [managed tenant contract](../../docs/multi-tenant.md) defines the future confidential service.

## Inspect a plan

```sh
npm run build
npm run host -- plan-fleet deploy/proxmox/fleet.example.json
```

The example uses the `proxmox-development` provider and assigns two distinct tenants to Ubuntu 24.04 KVM guests, each with 4 vCPUs, 16 GiB RAM, a 160 GiB private disk, and ten rehearsal session slots. It reserves 8 GiB for the host and leaves 24 GiB unallocated. Session count is not a throughput promise. Physical cores are shared across guests; vCPUs are not dedicated physical cores. Existing local plans should use this provider value.

Replace the example tenant UUIDs, addresses, management CIDRs, and resource budgets with actual values before provisioning. `192.0.2.10` is a documentation address, not the rented server. The disk budget is conservative planning input, not a measured usable capacity or RAID configuration. Do not format or repartition the rented server from this example.

The planner rejects duplicate tenant IDs, VM IDs, and guest IPs, aggregate overcommit, unknown/secret fields, and any tenant marked `private`. Output is a reviewable resource specification. It is not a firewall program, Terraform apply, live attestation, or proof that the VM exists.

## Provisioning boundary

Use full KVM guests rather than LXC containers. Each guest needs its own disk, runtime/agent users, provider home, context directory, application configuration, device keys, journal key, browser storage, temp space, caches, and backup namespace. Do not clone an already initialized Infinite image with its keys, Tailscale machine identity, or native credentials. Bake software into a clean image and initialize after cloning. No host directory or Docker socket is shared with guests.

Apply VM CPU limits, fixed RAM reservations, disk capacity, disk read/write rate limits, and process/file limits before testing. Set quotas on backups and monitor disk capacity. Use the current Proxmox tooling to apply the generated plan; this repository does not yet include an authenticated provisioning adapter.

Enforce network policy on the hypervisor: enable firewalling at the required datacenter/node/VM levels and on the guest NIC; deny unsolicited ingress, cross-tenant underlay traffic, management addresses, link-local/cloud-metadata endpoints, and IPv6 underlay access. Add IP/MAC anti-spoofing. Plan an allowed outbound path for DNS/NTP and the private overlay. RFC1918 denial is a destination policy, not a replacement for correct routing, bridge isolation, or ARP/neighbor protection. If the hypervisor itself provides DNS, add only that explicitly required resolver path.

Use an independently enrolled overlay identity per VM, shared only with its user. Do not put every user in an unrestricted common tailnet. Validate access with two actual guests, including IPv6 and management-plane probes. An ordinary VM owner must not be able to change the host-enforced rules. Keep provider-console recovery and a working management path before changing host firewall rules.

## Initialize inside each guest

Build and install the software using the existing [Ubuntu service instructions](../ubuntu/README.md), but initialize the development mode and retain its demo-only provider list:

```sh
node /opt/infinite/packages/host/dist/cli.js init \
  --config /etc/infinite/config.json \
  --deployment-mode tenant-development \
  --tenant-id b057f435-6b57-427b-8369-15c4ae77b198 \
  --state-dir /srv/infinite-data/control \
  --run-dir /run/infinite \
  --key-file /run/infinite-key/vault.key \
  --origin https://TENANT-VM.YOUR-TAILNET.ts.net \
  --project /srv/infinite-data/workspaces/rehearsal
```

Use a different UUID and guest for the second tenant. Set the generated config's `maxSessions` to its plan value. Do **not** copy the production `agents` block from the older personal-server instructions: this development mode deliberately rejects it. The guest must never receive real provider keys, personal repository credentials, or private context under this mode.

The current program still generates development keys inside the guest, where the operator could read them. Future confidential initialization must instead receive user-owned secrets over an independently verified encrypted channel into a protected runtime. Switching the mode string is deliberately rejected until that implementation exists.

## Evidence still required

Local tests prove that two configured Infinite instances do not share application collections or accept each other's tokens. They do not prove the Proxmox VM/network/storage boundaries. Actual guest creation, network isolation, resource enforcement, per-tenant restores, and host reboot behavior remain unverified until commissioned on the rented server.
