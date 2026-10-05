# Server choice

**Current decision supersedes the earlier shortlist:** the user has rented a Scaleway Pro-11-M-64G and selected managed confidential VMs as the target. Scaleway lists EPYC 4345P, 8 cores / 16 threads, 64 GB RAM, and 2 × 1 TB NVMe. AMD says EPYC 4005 lacks SEV. Use this server for development, control-plane services, and eventually encrypted relay/storage; it cannot supply the required operator-confidential execution. [Scaleway](https://www.scaleway.com/en/docs/dedibox-hardware/reference-content/server-comparison-table/), [AMD](https://www.amd.com/en/products/processors/server/epyc/small-business.html).

See [managed tenants](multi-tenant.md) for backend selection and [Proxmox development](../deploy/proxmox/README.md) for the local capacity plan. The comparison below is retained as the earlier personal-server research, not the current recommendation to buy another ordinary host.

The rented server now runs the owner's single-tenant pilot directly on Ubuntu, with private Tailscale access and an encrypted application volume. See [commissioning](../deploy/ubuntu/infinitebox.md) for live hardware and provider checks. This deployment does not establish the managed tenant confidentiality boundary.

Recommendation checked on 2026-10-04: look for a **Hetzner AX102-1-LTD with 128 GB RAM, mirrored NVMe, and the standard 1 Gbit/s uplink**. If the intended workload is ten simultaneous builds or browser-heavy test runs, compare an **AX162-1-LTD** before ordering. Limited-stock prices are listed offers, not verified inventory reservations.

The reference laptop is an Apple-silicon Mac with **14 CPU cores and 36 GiB unified memory**. An x86 server is not equivalent to its GPU, macOS applications, Keychain, Xcode, or unified memory architecture. The server comparison concerns Linux agent orchestration, compilation, tests, browsers, and storage. Native iPhone builds still need a Mac or a macOS build service.

## Shortlist

| Server | CPU and memory | Network | Listed USD price, excluding tax | Fit |
| --- | --- | --- | --- | --- |
| Hetzner AX102-1 | Ryzen 9 7950X3D, 16 physical cores / 32 threads; 128 GB DDR5; 2 × 1.92 TB NVMe | 1 Gbit/s, unmetered; Germany/Finland | $302.10/month + $149 setup, excluding IPv4; LTD: $187.10/month + $39 setup | Recommended starting point for 10+ mostly API-backed agents |
| Hetzner AX162-1 | EPYC 9454P, 48 physical cores / 96 threads; AX162 family offers 128–512 GB ECC | 1 Gbit/s, unmetered; Germany/Finland | $722.10/month + $359 setup, excluding IPv4; LTD: $372.10/month + $39 setup | More room for simultaneous builds; confirm the exact -1 RAM/storage in the order configurator |
| OVH US Game-2 2026 | Ryzen 9 9950X3D, 16 physical cores / 32 threads; 64 GB base with upgrades to 256 GB | 1 Gbit/s listed, unmetered | From $401/month + $401 setup; 128 GB upgrade extra | Consider when US latency matters; current page includes “Coming Soon,” so confirm regional stock |
| AWS EC2, suitably sized x86 instance | Select at least 64–128 GiB and enough sustained CPU; avoid a small burstable instance for sustained builds | Internet transfer is separately priced | Compute + EBS + IPv4 + transfer; obtain a regional quote | Best if AWS integration is a requirement; weaker fit for the requested egress economics |

Hardware sources: [AX102 configurator](https://www.hetzner.com/dedicated-rootserver/ax102/configurator/), [AX162](https://www.hetzner.com/dedicated-rootserver/ax162/), [OVH US Game](https://us.ovhcloud.com/bare-metal/game/). Pricing source: [Hetzner June 2026 price list, updated July 2026](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/). Old AX102/AX162 launch articles quote much lower prices and should not be used as current quotes.

Hetzner's default dedicated-server uplink has unlimited traffic. Its **10 Gbit/s option includes only 20 TB outgoing/month**, then €1 or $1.20/TB; it is not an unlimited 10 Gbit plan. Cloud VM allowances also differ by region. [Hetzner traffic terms](https://docs.hetzner.com/robot/general/traffic/).

OVH's dedicated-server bandwidth page describes unlimited, unmetered traffic, with guaranteed-bandwidth options distinct from burst bandwidth. [OVH bandwidth](https://us.ovhcloud.com/bare-metal/bandwidth/).

AWS gives 100 GB of internet egress free per month across eligible services/regions. The cited US East rate is $0.09/GB for the first paid 10 TB tier; 1,000 GB total egress would therefore add approximately $81 before other charges, assuming the free allowance is unused elsewhere. [AWS on-demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/), [AWS detailed transfer table](https://aws.amazon.com/ec2/pricing/on-demand-backup/).

## Why this sizing

The language models run at their providers unless local inference is explicitly added. GPU rental is unnecessary for ordinary Claude Code/Codex/Grok/OpenCode API use. Model subscription limits and charges remain separate from server capacity.

128 GB gives about 3.6 times the Mac's nominal memory capacity, useful for separate worktrees, language servers, build caches, browsers, and test databases. Physical cores and SMT threads are not interchangeable. AX102 should be a good starting point by capacity; no benchmark on this owner's repositories has established that it beats the reference Mac in every task.

Start with ten agent sessions and cap simultaneous heavy builds separately. Measure memory high-water mark, swap, disk I/O, build duration, browser count, and interaction latency during a representative hour. Choose AX162 if CPU-heavy jobs regularly queue while memory remains healthy. Choose more RAM when processes swap or fail from memory pressure. Do not infer sizing from idle terminal count.

Use 1 Gbit/s initially: 125 MB/s is its theoretical line-rate ceiling before overhead, ample for text/session traffic and often sufficient for ordinary repository workflows. Verify real Tailscale throughput and whether connections use a direct path rather than a relay. Large datasets or frequent multi-gigabyte artifacts can justify a different uplink.

## Proposed order

Ubuntu 24.04 LTS, AX102-1-LTD if available, 128 GB RAM, 2 × 1.92 TB NVMe in RAID1, default 1 Gbit/s uplink, and encrypted working storage. Choose Germany or Finland after a latency check from the owner's usual location. RAID1 provides about one drive's capacity and is not backup. Budget separately for encrypted off-host backups, IPv4 if needed, tax, and model plans.

If only the full-price AX102 is available, compare a current Hetzner auction listing and an OVH 128 GB quote before paying. Auction specifications and stock must be verified at purchase time. This document is a selection recommendation, not purchase authorization or a capacity guarantee; no account, final quote, location, or spending limit has been selected.
