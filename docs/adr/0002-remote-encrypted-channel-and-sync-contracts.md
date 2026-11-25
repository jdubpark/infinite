# ADR-0002: Remote Encrypted Channel, Wire Contracts, and Data-Only Rendering

- **Status**: Accepted
- **Scope**: `packages/remote/`

## Context

`@infinite/remote` is shared by the web app, React Native phone app, and Node host clients. It implements the end-to-end encrypted WebSocket channel, incremental session-list sync, data-only Markdown/Mermaid parsing and deterministic graph layout, memory wire contracts, and Workspace Understanding schemas.

## Decisions

### 1. Encrypted WebSocket channel, no-replay, and callback isolation
- **Handshake and keys**: Fresh per-handshake nonces bind directional cipher keys to the handshake and machine identity. The channel intentionally does not provide forward secrecy; tokens are shared secrets between paired devices and the runner.
- **Hex framing**: Wire encoding uses hex instead of Node `Buffer` or native base64 APIs so the module remains runtime-agnostic across Node, browsers, and React Native.
- **On-demand connect, never replay**: `createRemoteClient` connects on demand on explicit calls only. Disconnected terminals, pending requests, and uncertain input are never replayed automatically. `RemoteTerminal.send` is not a delivery receipt; callers correlate terminal receipts and refusals by `requestId`. Terminal messages preserve the host gateway's input and lease rules.
- **Send-order identity allocation**: Because readiness and `AbortSignal` cancellation can settle out of arrival order, replay-protected request IDs are allocated strictly in actual send order after readiness settles. Locally canceled reads may still produce a response from the runner and are ignored when no longer in `pending`.
- **Callback isolation**: Errors thrown by application callbacks (`onMessage`, `onEvent`, `onClose`) are caught and isolated so renderer bugs never tear down channel integrity.
- **Upgrade headers across runtimes**: Cloudflare Access service tokens (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) are checked by Cloudflare before reaching the relay. Because React Native reads WebSocket upgrade headers from the third constructor argument and Node reads them from the second (each ignoring the other, while browsers cannot send upgrade headers), `createRemoteClient` passes `{ headers }` in both positions.

### 2. Incremental session-list sync (`sessionListReader`)
- Clients retain a bounded, host-validated version token (`[A-Za-z0-9_-]`, max 128 chars) and send `?since=<version>`.
- Hosts supporting `since` return `{ version, unchanged: true }` when rows match, or `{ version, sessions }` on change; older hosts ignore `since` and omit `version`.
- Unreadable responses fall back immediately to a plain `GET /sessions` and re-enable `?since=` on the next read.
- Overlapping reads are ordered by request sequence: a late response older than the currently held rows does not overwrite newer rows, and `unchanged` applies only when its version matches the currently held snapshot. Callers maintain one reader per host.

### 3. Memory wire contract authority and accounting
- Authority for every memory operation comes strictly from the authenticated host context, never from client payload fields.
- Cost and quota microunits cross the wire as canonical nonnegative decimal integer strings; host accounting performs exact `BigInt` arithmetic.

### 4. Data-only Markdown, Mermaid, and deterministic diagram layout
- Rich text (`WorkBlock`) and diagrams (`Diagram`, `KnowledgeDiagram`) are transported and rendered strictly as typed data structures, never as executable HTML, JS, or Mermaid eval.
- Markdown links accept `https:` URLs only; all other schemes degrade to plain text.
- Mermaid parsing rejects trailing statements on the direction header line so nothing is silently discarded, and blocks unsafe `link`/`links` directives while still allowing `link`/`links` as ordinary node or participant identifiers. Original Mermaid text is preserved separately so clients can display raw source when parsing fails.
- Deterministic layout (`diagram-layout.ts`, `work-diagram-layout.ts`) uses no DOM or Node APIs:
  - Cycle handling reverses only DFS back-edges in the layering graph while keeping rendered edge direction intact.
  - Grouped graphs reserve top header clearance and row spacing for group boxes, run four barycenter sweeps (down, up, down, up; tie-breaking by group ID then input order), and keep same-group members contiguous per layer. Groups whose bounding box across multiple layers would enclose a non-member node omit the box rather than misstating membership.

### 5. Workspace Understanding honesty and provenance contracts
- Generated briefs, work narratives, source observations, and parsed diagrams describe recorded commits, reports, or snapshots; they never certify completion, delivery, or deployment. Execution status comes from the source record, and owner assessments remain independent of execution.
- Source citations use `null` line numbers for file-level observations rather than fabricated line numbers. `observedAt` timestamps record read time without implying external environments were re-checked then.
- Work briefs keep deterministic host/source facts separate from model-generated narrative (`narrative`), mark cached narratives for older heads explicitly as stale, and tag every section with provenance (`source`, `agent`, `owner`, `model`, `host`).
- Behavior verification definitions (`understanding-behavior.ts`) are data-only (no expressions, modules, shell commands, or executable markup); empty property predicates cover every state, and reachability is checked independently of truth.
- Knowledge maintenance runs model writers only when explicitly enabled in workspace config and a host writer is configured; mutations require caller UUID plus catalog revision to guard against replay and concurrent races. Optional fields on `WorkspaceUnderstanding` preserve wire compatibility with older hosts/clients.

## Consequences

- `createRemoteClient` and `sessionListReader` encode their internal lifecycle states as discriminated unions (`ClientConnection` and `HeldState`), preventing leaked handshake timers, half-open cipher channels, and version/row mismatches at compile time.
- `packages/remote/src/` carries zero prose comments under `scripts/check-comments.mjs`.
