# MCP request connector

An external assistant can discover enrolled projects, queue a tracked request,
read progress and questions, reply, and pause, resume, or cancel a started
request. Infinite executes the work through its existing [intake](intake.md)
and [mission](missions.md) services. The connector is disabled unless the host
configuration contains `mcp`.

## Prepare a release

Use Node.js 22.14+ and the existing [host installation](../deploy/ubuntu/README.md).
Check the Node executable used by the service, not only the interactive shell.
Validate the final candidate in a clean checkout with all workspace development
dependencies, including mobile:

```sh
npm ci
npm run check
```

In a separate release staging checkout on the target platform, install the host
and web dependencies and build. Mobile dependencies are unnecessary there:

```sh
npm ci --workspace @infinite/host --workspace @infinite/web --include-workspace-root
npm run build
```

Install the built host, web and shared packages together with their runtime
dependencies and lockfile. The host build uses TypeScript without bundling: copying `dist` alone
omits the required `@modelcontextprotocol/server`, `@modelcontextprotocol/node`,
Express and their dependencies. Build on the target platform for `node-pty`.
Keep the previous release available; do not replace a running checkout's
dependencies in place.

## Host configuration

Configure normal project enrollment, mission agent profiles, `teams`, `linear`,
and `intake` first. MCP requires both Linear tracking and intake; it never falls
back to untracked execution. A connector-only instance can set
`intake.linear.admitIssues` to `false`, omit Slack, and set
`intake.requireSlackThread` to `false`. The first configured intake Linear team
receives connector issues. Existing intake queue and mission limits still apply.

Add this block to the private host configuration, replacing every example value:

```json
{
  "mcp": {
    "port": 4781,
    "origin": "https://connector.example",
    "connectors": [{
      "id": "grok-assistant",
      "name": "Agent Swarm",
      "tokenHash": "REPLACE_WITH_SHA256_HEX",
      "projectIds": ["api", "web"]
    }]
  }
}
```

Use a separate random bearer credential for this connector. Generate it in a
private directory outside the repository and runtime/project roots, with shell
tracing disabled. This example writes the secret to a new file without printing it:

```sh
umask 077
node --input-type=module -e '
  import { randomBytes, createHash } from "node:crypto";
  import { writeFileSync } from "node:fs";
  const token = randomBytes(32).toString("base64url");
  writeFileSync("connector-token", token, { mode: 0o600, flag: "wx" });
  console.log(createHash("sha256").update(token).digest("hex"));
'
```

Copy the printed digest into `tokenHash`; enter the file's secret only in the
connector's private HTTP header field. Do not put it in chat, a URL, source,
screenshots, proxy logs, or owner device configuration. An owner device token
cannot authenticate to MCP. The MCP credential does not pair a device or grant
owner API access.

`projectIds` lists **individual enrolled host project/checkout IDs**, not project
group IDs. Obtain them from the private host configuration's `projects[].id` or
the authenticated owner project listing. For a personal instance intended to
expose all current projects, explicitly list every current enrolled ID. New
projects and checkouts require explicit enrollment in this allowlist; future
projects are never included automatically. There is no wildcard.

`list_projects` returns the safe IDs and names of eligible **project groups**.
Pass one of those IDs as `start_request.projectId`. A group appears only when
all of its member checkouts are allowed. Admission pins group membership and
checkout selection. Scope revocation or changed repository membership or checkout
selection holds queued work and denies further connector access rather than
silently choosing different code.

Restart the host using its normal service manager after configuration changes,
or run `npm run host -- serve --config CONFIG_FILE` from a built checkout for a
foreground host. Startup binds MCP to `127.0.0.1` on its separate port. A bind
failure fails startup and releases both listeners. Preserve the host vault key
and state across restarts: those hold request identities and retry receipts.

## HTTPS exposure

Expose exactly `/mcp` on a dedicated HTTPS origin, forwarding to the separate
loopback MCP port. Keep that port inaccessible from external interfaces. Never
forward this connector origin to the main owner API or expose `/api`, terminal,
pairing, hook, or file routes through it.

For example, inside an existing Nginx TLS virtual host for `connector.example`:

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:4781;
    proxy_set_header Host $http_host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Origin $http_origin;
    proxy_buffering off;
}
location / {
    return 404;
}
```

Provision a valid public TLS certificate through the normal deployment process.
The configured `mcp.origin` must match the public HTTPS origin. Preserve
Authorization, MCP protocol headers, JSON bodies and response media types.
Preserve the original Host and any client Origin; do not rewrite an untrusted
authority or Origin into a trusted one. Configure the TLS virtual host to reject
unmatched hostnames. The listener validates Host and any Origin itself and does
not trust forwarded headers as authentication. Its transport is stateless
Streamable HTTP; GET and DELETE on `/mcp` return method errors. It grants no
browser CORS access.

## Grok Bot setup

Create a personal Bot named **Agent Swarm** using **New Bot** (`+`) on desktop
or phone, or select an existing Bot. On desktop, open **Connect apps →
Add a custom connector**, name it **Infinite**, select **Remote HTTPS**, enter
`https://connector.example/mcp`, and add the private HTTP header
`Authorization: Bearer CONNECTOR_TOKEN`. Save with **Add plugin**, then attach
the connector to the task using `@`. An organization MCP policy can prevent
installation. These controls and account-wide App availability are described
in the [official Grok Bot connector documentation](https://docs.x.ai/grok-bot/computer-and-apps).

The Bot name is a workflow label. Apps belong to the Grok account and may be
available to every Bot on that account. Infinite's credential and project
allowlist enforce the boundary; the Agent Swarm name does not isolate access.
Treat every Bot able to use this connector as able to invoke its allowed tools.

Personal Bots receive their lasting role and boundaries through chat; there is
no personal Bot instructions/settings page. The [official Bot setup guide](https://docs.x.ai/grok-bot/bots)
recommends giving these in the first message and asking the Bot to remember.
Sign into the same account on your phone: [mobile shares the same Bots,
conversations and connectors](https://docs.x.ai/grok-bot/mobile).

Attach **Infinite** and send this **INITIAL SETUP MESSAGE** from desktop or phone:

```text
You are Agent Swarm, my interface to repository work through Infinite. Remember
this role, the following tool rules, and approval boundaries for future chats.
Use the attached Infinite connector for this role. It is intended to expose all
currently enrolled projects; do not widen access or assume future enrollment.
Call list_projects and use an exact returned project ID. Ask which project when
the requested target is ambiguous. Submit only the user's authorized objective.

For each new start_request, create and retain a UUID requestId. Save the full
arguments and returned runId. Retry an uncertain delivery with the identical
requestId and arguments; never invent a new request to work around a timeout.
Reusing a requestId with changed content conflicts.

Read get_request before answering or controlling work. Use its current revision,
availableActions, and the exact decisionId for the question being answered.
For each new reply/control, retain a fresh UUID requestId and identical arguments
for delivery retries. On stale-revision or changed-question errors, read again
and decide a new action from the current state; do not guess or reuse a question.
Omit decisionId only for deliberate steering rather than a question answer.

Report queued as queued, and tracking.pending as tracking not yet confirmed.
A runId means durable admission, not that an agent started or finished. Queued
requests have no reply or lifecycle controls. Poll get_request with backoff;
do not claim cancellation when request-not-started is returned.

Present result.kind=agent-report as the agent's report. Ready-for-review does
not prove merge, deployment, tests beyond reported evidence, or product impact.
Show the tracker link only when returned. Surface blocked states and questions.

These tools do not approve provider permissions or grant broader owner access.
Direct permission decisions to the owner's established Infinite permission flow.
Never request or display credentials, private config, terminal logs, or unrelated
requests through this connector. A denied request requires owner investigation.

Your first task is read-only connection validation. Call list_projects and
report the exact returned IDs and names, whether discovery succeeded, and any
errors. If I explicitly provide a prior runId, read it with get_request and
summarize its current status; otherwise do not guess IDs or read other requests.
Do not call start_request, reply_to_request or control_request during setup.
Do not start a swarm, schedule routines or modify host configuration. If the
connector is unavailable, report the blocked prerequisite without asking for a
credential in chat. Confirm these boundaries and wait for my explicit work request.
```

## Tool contract and retries

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_projects` | Empty object | Allowed group IDs and names. |
| `start_request` | UUID `requestId`, `projectId`, `objective`, optional `title` | Durable request view, initially queued with tracking pending. |
| `get_request` | UUID `runId` | Current request view. |
| `reply_to_request` | `runId`, UUID `requestId`, current integer `revision`, `text`, optional UUID `decisionId` | Updated view after guarded question answer or steering. |
| `control_request` | `runId`, UUID `requestId`, current `revision`, `action` (`pause`, `resume`, `cancel`) | Updated view after the guarded action. |

Start objectives are limited to 24,000 characters, titles to 100, and replies to
8,000. Each view contains status, tracking state, open questions, available
actions, and a revision once a mission exists. Results carry
`{ "kind": "agent-report", "summary": "..." }`. Views exclude raw host config,
credentials, filesystem paths, terminal output and other connectors' requests.

Identical start retries retain one tracker issue and mission, including after
restart. Identical successful reply/control retries reuse their durable receipt.
A changed payload under the same key conflicts. A stale revision requires a
fresh read. Queued or tracking-pending requests reject mutation with
`request-not-started` and remain queued. Tracker outages keep work waiting;
they do not authorize a local execution fallback.

Connector objectives, follow-up replies and child-team answers retain connector
provenance rather than being represented as direct human input. Linear receives
the filed request and fixed lifecycle receipts; the detailed report is read
through the connector.

## Deployment and rollback

Prepare the release and private configuration before changing the running host.
Keep actual project IDs, credential material and operational receipts outside
tracked source. For all current projects, compare the explicit checkout allowlist
with the current enrollment and the expected group membership.

1. Record the current release and privately preserve its configuration. Confirm
   the existing Linear credential, intake team, mission agent group and provider
   authentication work; MCP does not provision them.
2. Stop new submissions and use the owner's [halt controls](teams.md#halt) to
   hold launches. Confirm active missions are paused or finished and explicitly
   stop any sessions that must end before replacing their runtime. Check for
   pause failures. An API restart preserves detached workers; it does not itself
   quiesce work.
3. Install the prepared release and private MCP configuration, preserving the
   current vault key and state. Keep the connector ID stable across upgrades.
   Configure the dedicated HTTPS route above; keep the owner API private.
4. Restart through the existing service manager, confirm both loopback listeners
   and service health, then perform the read-only commissioning checks below.
   Release the owner halt only when ready to admit explicitly authorized work.

If validation fails, disable the dedicated public connector route and revoke
access as described below. Inspect active missions and surviving sessions through
owner controls separately. Restore prior code/configuration only after checking that
the prior release can read the current state. Preserve the current vault key,
state and request receipts; do not roll evolving state back to an older snapshot.

## Rotation, revocation and commissioning

Rotate by generating a replacement secret, changing `tokenHash` for the same
connector ID, restarting the host, and updating the connector header. Old bearer
values must fail after the replacement is active. Keep the connector ID stable
to retain ownership of its prior requests. Remove the connector or the `mcp`
block to revoke it; restart the host. If removing the last connector, remove the
whole `mcp` block. A connector-only intake with `admitIssues: false` and no Slack
direct requests also needs its now-unused `intake` block removed; do not enable
Linear issue admission as a revocation workaround. Changing an allowlist revokes
connector access to requests outside that scope and prevents queued launches. Revocation
does not itself stop work already running: use the owner controls when required.

Before relying on a live connection:

1. Check the dedicated TLS endpoint and ensure `/api/me` and every other path
   are unavailable there. Verify missing/invalid credentials and mismatched
   Hosts and Origins are rejected. Verify an unavailable MCP upstream cannot
   fall through to the owner API.
2. Discover exactly the intended groups. Check a non-enrolled checkout cannot
   be discovered or used, and verify the account-wide App exposure is acceptable.
3. Send the initial setup message and confirm it only discovers projects or reads
   an explicitly supplied run. Separately authorize one small request on a
   returned project ID, retain its UUID and runId, retry it unchanged, and confirm
   one Linear issue and one mission. For example, replace `PROJECT_ID` in this
   separate work message: "In PROJECT_ID, inspect the repository's documented
   check commands and report which checks would apply to a documentation-only
   change. Do not edit files, commit, push, deploy or contact external services."
4. Read progress on mobile, answer the exact current question, and verify the
   reply's connector attribution. Check pause/resume/cancel on a started request
   and verify stale input requires a fresh read.
5. Restart Infinite and reread the same run. Rotate or revoke the test credential
   and verify the former credential cannot invoke tools.

`tests/mcp-e2e.test.ts` exercises the official SDK against a real local host,
fake Linear server and deterministic mission workers, including duplicate
delivery, a delegated answer, an agent report and restart identity. This is local
protocol and host evidence. Live Grok authentication, desktop/mobile behavior,
the public TLS proxy and deployment require the commissioning checks above.
