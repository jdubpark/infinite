# Host permission agent: one separate agent decides agent permission requests (INF-226)

## Intent

Agent work on the host still stops on yes-or-no permission requests. A team run's reviewer decides only its own members' prompts, inside a count limit, and sends the rest to the owner. A session outside a team run has no reviewer, so its prompt waits for the owner. A headless member has no prompt at all, so a command outside its fixed allowlist is refused at once (INF-223).

The owner's direction on 2026-11-14: one separate permission agent, not tied to a workspace, allows or rejects the requests that today need a person. The owner intervenes less, and work is not blocked on a permission.

## Owner decisions (2026-11-14)

| # | Question | Decision |
|---|---|---|
| 1 | Sessions covered | Every agent session on the host. |
| 2 | Requests that still interrupt the owner | Production or staging actions. New or external credentials. Money. Destructive operations outside the workspace. Global or account settings. |
| 3 | An uncertain request | Rejected with a reason. The reject is recorded for the owner to review later. |
| 4 | Limits | No decision count limit and no spend fuse on permission decisions. The decision rate is tracked. Guardrails cover behaviour that could make the agent go rogue. The owner's example: it only responds to requests from agents, and it never tells a requesting agent what to do. |
| 5 | Model | A light model for routine requests. A strong model from a different family than the requester for uncertain ones. |
| 6 | Authority | One recorded workspace-level delegation from the owner, in place of the per-repository scope. The owner approved it for every workspace that exists on the owner's host. |

## What exists today (observed in code at main `15db476`)

- A repository enrollment saves `permissions { mode: "coordinator", scope, maxDecisions }` on a host project (`teamProjectSchema`, `RepoEnrollmentService`), and each run pins it (`currentPermissions`). The default limit is 25 decisions and the maximum is 50.
- One read-only permission reviewer serves a run revision. It must be a Claude profile. It reports approve-once, request-evidence or escalate, inside a five-minute window for each turn. An identical request can reuse a recorded verdict (`permissionReuseKey`, `permissionAuthorityHash`).
- A prompt qualifies for approval only with complete evidence and a one-shot accept option: hook tool input that is complete, or a screen dialog pinned at the bottom that shows its whole command. A prompt that the host's destructive detector flags never qualifies (`oneShotPermissionOption`). An incomplete or collapsed prompt can get a diagnostic review, which can never approve.
- A prompt of a session outside a current run belongs to the owner (`TeamService.promptOwner`). Inside a run, only the permission reviewer's own prompts are excluded by role.
- The notifier holds a member's prompt while the run can still decide it. It pushes the phone when the request becomes the owner's, when the run has not started a review inside a short grace period, or at an absolute hold limit.
- The host delivers a recorded choice only after it checks the assignment, the workspace, the prompt identity and evidence, the policy, the expiry and the human control lease. A refusal before the first key escalates. A failure after it is recorded as uncertain and never replayed.
- A diagnostic review of an incomplete prompt can pass its written cause to the project manager and to mission coordinators through permission recovery (`queuePermissionRecoveryPm`).
- Workspace trust, persistent allow rules, ambiguous prompts and unsupported native requests are never delegated.
- A hook reply never becomes a provider hook decision. Only the relay reads it (`HookReply`).
- Clients show a workspace as a project group (`ProjectGroup`). A group folds the host projects that are checkouts of one repository, and the owner can group further projects. A session stores its host project id. A team member's session stores its run's project id. Groups do not change repository policy today.

## Goals

- In a delegated workspace, a request from any agent session gets a recorded decision with no owner action.
- In a delegated workspace, only a request in one of the five interrupt classes, or one that the host cannot deliver, reaches the owner.
- A headless session's request outside its allowlist gets a decision in place of an immediate refusal.
- The owner can read every decision, and every reject with its reason, after the fact.
- The permission agent cannot steer other agents, widen its own authority, or act when no request is pending.

## Non-goals

- Sessions that run on another machine (an online laptop, or sessions found in cmux). They are not on the host.
- Changing provider sandboxes, provider modes, global trust settings or credentials.
- Deployment. This feature never deploys anything, and a deploy request is an interrupt class.
- A budget for permission decisions. The owner removed the count limit and the spend fuse.
- Learning from decisions. Recorded decisions and the owner's later marks change no policy.

## Constraints

- The host decides nothing itself. Host rules can leave a request with the owner, reject a locked assignment, replay a recorded verdict, or force the stronger tier. They can never allow a request.
- An agent never decides its own request. The permission agent's model turns are sessions of their own and do none of the work.
- Each decision is for one current one-shot request. No persistent approval, trust setting or allow rule is granted.
- Each decision is recorded with its evidence before delivery.
- A reject is final for that request until the owner reopens it.
- The stale-request and human-control checks of today's delivery path stay.

## Design

### Terms

- **Workspace**: a project group as the clients show it. Its identifier is the group id. Every host project is in exactly one workspace.
- **Request**: one yes-or-no tool permission that a provider raises for one action. In an interactive session it is a permission dialog. In a headless session it is a permission call.
- **Requester**: the agent session that raised the request.
- **Task**: the unit of work a requester belongs to. It is the team run for a member, across every member and revision of that run. It is the session itself for a session outside a run.
- **Assignment**: the seat a requester works in. For a team member it is the run and the member's task, or the run and the role when the member has no task of its own. A replacement member and a new run revision keep the assignment. For a session outside a run it is the session.
- **Session root**: the canonical path of the directory the host assigned to the session, plus its host-assigned scratch directory. For a team member it is the member's own clone. For another session it is its project's checkout. "Outside the workspace" in the fourth interrupt class means outside the session root.
- **Permission agent**: the host service that takes a request, runs model turns to decide it, records the decision and delivers it.

### Authority: the workspace delegation

The owner records one delegation for each workspace. The record is keyed by the group id. It holds the owner device, the time, the host projects it covers with the repository identity of each, the interrupt classes in force, the policy version, and optional owner direction text.

- Only an owner client can record, change or revoke it: `infinite permissions delegate [--workspace W | --all]`, `infinite permissions revoke`, `infinite permissions status`, and the matching API with the same owner-client check as repository enrollment.
- A session is covered when its stored project id is in the record. The host resolves the session to a workspace through that project id, never through a path.
- An opt-out is recorded for one project and always wins over automatic coverage. Only an explicit `permissions delegate` replaces it.
- A new checkout of a repository that the record already covers, with no opt-out, is admitted when it folds into the workspace. The host adds its project id to the record as an automatic admission, with the repository identity and the time. A checkout with no captured identity is never admitted automatically.
- A project of another repository that the owner groups into the workspace later is not covered until the owner records the delegation again. `permissions status` shows such a workspace as partly delegated.
- A project that the owner moves out of the workspace loses its coverage at once. When the host itself folds a covered checkout into its repository's group, the delegation follows the checkout.
- A workspace with no record has no permission agent. Its requests wait for the owner, with today's notifications.
- Owner-initiated onboarding of a repository records the delegation for its workspace by default. `--permissions off` records an opt-out for that project. This keeps today's product rule.
- A revoke stops new decisions at once. Decisions that are pending for that workspace are retired and never applied. `infinite team revoke-permissions TEAM_ID` still returns one run's requests to the owner.
- The record pins the interrupt classes. A host release can add a class to existing delegations. It cannot remove one: a shorter list needs a new delegation from the owner.
- Owner direction text can only narrow what the permission agent allows in that workspace. The interrupt classes and the host rules apply whatever the text says. A change to the text changes the authority: earlier verdicts are not replayed and open rejects are closed.

The delegation replaces the enrollment's `scope` and `maxDecisions`, and the `--permission-scope` and `--permission-limit` options. An upgrade converts nothing by itself, because the new delegation is wider than the old one: it covers every session and it rejects without the owner.

- `permissions delegate` is the owner's newer decision. It replaces a saved opt-out or a saved custom scope on every project it covers, and it prints each one that it replaced. A saved custom scope is not converted into direction text, because a scope grants and direction text only narrows.
- Without that command, a saved opt-out stays an opt-out and a saved scope is no longer used.
- Runs in flight stop using their pinned policy at the upgrade. Their pending delegated decisions are retired. Later requests follow the workspace delegation, or wait for the owner where none is recorded.

The permission agent serves a workspace only when the host is ready: a light profile and strong profiles from at least two families are configured. On a host that is not ready, a delegated workspace behaves as a workspace with no record, and `permissions status` says why.

### Coverage

| Session | Covered |
|---|---|
| Team members in every role, including the project manager, the integrator, the reviewer and the delivery role | Yes. A delivery request keeps the pinned delivery policy and its host checks as additional conditions. |
| Goal and mission coordinators, and sessions that the owner, a routine or intake starts in a workspace | Yes. While a person holds input control of the session, the request stays with that person. |
| Headless sessions | Yes, through the permission channel, for providers that pass the spike. |
| The permission agent's own model turns | Never. A permission need inside one is denied, as today. |
| Sessions whose project has no delegation | No. They stay with the owner. |

Until a slice covers a session kind, requests of that kind are handled as today.

### Decision pipeline

Each step either ends the request or passes it on.

1. **Class rules** (host). A host rule that establishes an interrupt class sends the request to the owner. No model turn runs, no verdict can allow it, and no recorded verdict is replayed for it. Class rules run first, on whatever the request shows, so they also catch a request that offers no one-shot choice. Each class has established predicates:
   - Production or staging: an action that the workspace's delivery or deployment configuration, or the host's own release tooling, names as a deploy, promote, roll-out or release command.
   - New or external credentials: a login, token-creation or key-import command on the host's list; a write under a credential store path; a read of a credential path outside the session root.
   - Money: a call to a payment, billing or purchase tool or endpoint on the host's list.
   - Destructive operations outside the workspace: a request with the destructive flag whose target the host resolves to a path outside the session root.
   - Global or account settings: a workspace trust prompt; a request that can be granted only as a persistent approval; a write to host configuration, the delegation records, the permission policy or journal, a provider launcher, or a provider or tool settings file outside the session root.

   A request whose effect the host cannot establish is not matched here. It is raised in step 5.
2. **Qualify** (host). The request must have complete evidence and a one-shot accept and reject choice. This is the structural part of today's check. The destructive flag no longer disqualifies a request. It raises it in step 5. Bounded evidence collection and the guarded display expansion run as today.
3. **Lock** (host). A request from a locked assignment gets a reject with `locked`. See "Rejected requests and probing".
4. **Replay** (host). An identical request under the same authority gets the recorded verdict again, with no model turn. The reuse key stays as it is today, without the run's decision limit. The host checks eligibility first. An `allow` is replayed only when the task has no open reject that was recorded after it. A reject is replayed unless the owner reopened it. `unavailable` and `locked` results are never replayed. A strong verdict is replayed only when its reviewer's family also differs from the current requester's.
5. **Raise** (host). Some requests must go to the strong tier: a request with the destructive flag, a target outside the session root, a publish, deploy, release or promote verb that no class rule matched, privilege elevation, a credential-like or payment-like name, a settings file inside the session root, and any request from an assignment that has a reject in its history. Raise rules are broad on purpose. They only select the tier.
6. **Light turn**. The light model reports `allow` or `refer`. It cannot reject, and it cannot send a request to the owner.
7. **Strong turn**. A strong model whose family differs from the requester's reports `allow`, `reject` with a reason code and a note, or `owner` with an interrupt class and a note. An `allow` must state that no interrupt class applies. The strong model can request up to eight source paths for bounded read-only collection, as today.
8. **No confident verdict**. A strong model that is not sure reports `reject` with `uncertain`. An invalid report, an expired review window, or no qualifying strong profile is a reject with `unavailable`, after the host retried inside the five-minute window.

| Verdict | What the host does |
|---|---|
| `allow` | Delivers the one-shot accept after the live checks. For a request that carried the destructive flag, delivery also requires that the verdict came from the strong tier. |
| `reject` | Delivers the reject with the fixed notice. Records the reason for the owner. |
| `owner` | Leaves the request pending and pushes it to the owner with the class. |

The policy that both tiers read is one host-level text. It allows one-time development operations that an engineer would routinely run for the task inside the session root: the same operations as today's default scope, including work outside the provider sandbox with network access, local sockets, IPC and task-owned temporary files. It names the five interrupt classes and tells the model to report `owner` for them and never `allow`.

### Rejected requests and probing

The journal keeps each assignment's rejects. They survive a rotated conversation, a replaced member, a new run revision and a host restart.

- An **effect reject** has the code `outside-workspace`, `unrelated` or `unsafe`. It stays **open** for its task until the owner reopens it, the workspace's direction text changes, or the task ends.
- An **evidence reject** has the code `incomplete` or `uncertain`. It is replayed for the identical request. A clearer request gets a fresh review.
- An `unavailable` or `locked` result is neither. The same request can be reviewed again.
- Every model turn for a task receives that task's open rejects and the requesting assignment's evidence rejects: for each, the tool, the action as the host extracted it, and the reason code. The policy tells the model to reject a request that has the same effect as an open reject, whatever tool or spelling it uses, and to report which open reject it repeats.
- An assignment with a reject in its history is always raised to the strong tier.
- When the strong tier rejects a request as a repeat of an open reject, the host counts the repeat on that open reject. At the second repeat from one assignment, that assignment is **locked**: each later request from it is rejected with `locked` and no model turn. Unrelated rejects and reviewer outages never lock.
- The lock belongs to the assignment, so a replacement member inherits it. It ends when the owner reopens the repeated reject, when the owner unlocks the assignment with `infinite permissions unlock`, or when the task ends. A locked assignment is shown as blocked on a permission. In a team run the coordinator sees that state through the existing blocked-member path, as a fixed host status.
- The owner reopens a reject with `infinite permissions reopen DECISION_ID`. Reopening allows nothing. It closes the reject, removes it from replay, and lets the same request be reviewed again.

The lock is a targeted stop for one assignment that asked three times for an effect that was rejected. It is not a limit on the permission agent's decisions.

### What agents receive

The requester receives a fixed notice that the host wrote, with a reason code from a closed list. It never receives text that a model wrote. The model's note goes only to the record.

| Code | Meaning |
|---|---|
| `outside-workspace` | The action reaches outside the session root. |
| `unrelated` | The action does not serve the task. |
| `unsafe` | The action looks destructive or malicious. |
| `incomplete` | The evidence does not show what the action does. |
| `uncertain` | The permission agent could not decide with confidence. |
| `unavailable` | No qualifying model could review the request in time. |
| `locked` | The assignment repeated a rejected request twice. |
| `needs-owner` | Headless only: the request needs the owner's own answer and cannot wait. |

No other agent receives model text from the permission agent either. Permission recovery keeps bounded evidence collection and the guarded display expansion. Where it informs a project manager or a mission coordinator, it sends a fixed host outcome with the code. The written cause of a diagnostic turn stays in the record. Run status, Swarm and Linear show codes and host-written text, never the note.

Member and session instructions, which the host writes, tell an agent that a reject is final for that request and that it must not reach the same effect with another tool.

### Delivery

Delivery to an interactive dialog keeps today's live checks: the target session, its session root, the prompt identity and evidence, the authority, the expiry and the human control lease. A screen dialog must still be pinned, with its exact title and detail checked before each key. A reject is delivered only through a recognized one-shot reject option.

The journal records a decision event before any key is sent, and then linked delivery events: intent, receipt, refusal or uncertain. After a crash the host reads these events and never repeats a delivery whose result is unknown.

- A request that changed or closed before delivery is recorded as stale. Nothing is sent and nobody is pushed.
- A dialog that the host cannot answer in either direction, or a delivery whose result is uncertain while the dialog is still open, goes to the owner as `undeliverable`. This is a host limit and not a sixth interrupt class. Each case is a defect to fix in the parser or the delivery path.

### Owner notification

| Situation | The owner is pushed |
|---|---|
| Delegated workspace, verdict `allow`, `reject`, `locked` or a stale request | No. |
| Delegated workspace, a class rule or an `owner` verdict | Yes, with the class. |
| Delegated workspace, `undeliverable` | Yes. |
| A person holds input control of the session | As today. The request is that person's. |
| No delegation, a revoked delegation, a run whose delegation the owner revoked, or a host that is not ready | As today. |

### Sessions outside team runs

A session outside a run has no assignment. The permission agent uses the host's own session record instead: the session id, its stored project id, its session root, its provider and its launch profile. The task evidence is the session's title and the prompts that the owner or the launching routine submitted, bounded, and marked as distinct from agent output. The live checks at delivery are that the session still runs, the request is unchanged, the session root is unchanged, the project is still covered, and no person holds input control.

### Headless sessions

A headless session has no dialog. Its request reaches the permission agent through a permission channel, and the provider waits for the answer inside its own timeout.

- The channel is separate from the signal hooks. A signal hook reply still never becomes a provider decision.
- The channel is bound to the session's assignment token, like the report tool. One session cannot ask for, or answer, another session's request.
- The answer is `allow` or `deny` with the fixed notice.
- A launch profile's allowlist and deny rules stay and keep priority. The channel decides only the calls that they leave open.
- If the channel is down or the answer does not arrive in time, the call is denied.
- A request in an interrupt class cannot wait for the owner. It is denied with `needs-owner`, recorded, and pushed to the owner with the class. If the owner approves it, the host records a single-use grant as the owner's own decision. The grant is bound to the requesting session and to the request's evidence, which includes the tool input and the session root. The host consumes the grant durably and exclusively before it answers, so two requests cannot use it. The grant is never replayed as a verdict, it is retired when its delivery is uncertain, and it ends with the session. A replacement session of the same assignment can use it only when the owner chose that in the answer. It is not a persistent approval.

For Claude Code, the documentation (read 2026-11-14) describes two mechanisms for a session that cannot show a prompt: a permission prompt tool, which is an MCP tool named at launch, and the `PermissionRequest` hook. It states that allow rules run without consulting either, and that a call a deny rule refuses stays refused. It does not state the timeout of a permission prompt tool call, or whether that tool's deny message reaches the model. The spike in "Delivery slices" measures both on the host's provider version before the mechanism is chosen. A provider whose headless mode fails the spike keeps today's behaviour, and `permissions status` lists it as not served.

### Record and owner review

The journal holds, for each request: the evidence hash, the requester's session, role, provider and model family, the task, the workspace and its delegation, the host rules that matched, the tiers and profiles used, the verdict, the code or class, the model's note, the timings, the replay source, and the linked delivery events. It is append-only. It is a table of its own in the host's evidence store, keyed by workspace, because the store's existing events belong to runs. A team run's status still lists its members' decisions.

The owner reads it with `infinite permissions log [--rejected] [--raised] [--workspace W] [--since T]`, the matching API, and later the daily digest and the clients. Nothing is pushed for a reject.

The owner can mark a decision `wrong` with a note. The mark is a record only. To change future decisions, the owner reopens a reject or changes the workspace's direction text.

### Decision rate

The host tracks decisions per hour for each session, task, workspace and the host: by verdict and tier, with replays and the median time to a decision. Status and the API show the figures. The digest marks a session whose decisions in the last hour exceed three times its workspace's median hourly rate per session over the previous seven days, with a floor of twenty. Nothing stops on a rate.

### Guardrails

- **Responds only.** A model turn starts only when the host holds a pending request. The permission agent has no schedule, no inbox and no way to start a turn.
- **Closed output.** Each tier reports through one authenticated report tool with a closed schema. The host discards anything else and treats the turn as having no verdict.
- **No instructions to agents.** A requester receives only the host's fixed notice and a code. No other agent receives model text. The permission agent has no channel to any agent.
- **No tools.** A model turn runs noninteractively with built-in tools disabled. It cannot read, write or run anything. The host collects evidence for it.
- **Request text is data.** The request, the command source, the open rejects and the task text are marked as untrusted evidence in the turn. The policy and the classes come only from the host.
- **Host rules only restrict.** A host rule can send a request to the owner, lock, replay or raise. No host rule allows.
- **Established classes cannot be allowed.** A request that a class rule matched never reaches a model and never replays.
- **No self-decisions.** A request from a permission agent turn is denied. The strong tier's family differs from the requester's.
- **No wider authority.** The permission agent cannot change the delegation, the classes, the policy, its own configuration or its launcher. A class rule sends any such request to the owner.
- **One-shot only.** It chooses a one-shot accept or a reject. It never chooses an option that persists.
- **No carry-over.** A conversation serves one task and rotates after 30 turns. Only the host-kept rejects pass from one conversation to the next.
- **Probing stops.** Open rejects reach every turn, an assignment with a reject is raised, a newer open reject stops the replay of an earlier allow, and an assignment that repeats a rejected request twice is locked.

### Model turns

Host configuration names the profiles: `permissionAgent.light`, and `permissionAgent.strong` as an ordered list from at least two families. Until `permissionAgent.light` is set, the host reads `teams.lineup.permissionReviewer`.

A profile's family is its model vendor: for example Claude, GPT, DeepSeek, Muse or Grok. The host establishes a requester's family from its provider when that provider runs one vendor's models, and otherwise from the session's selected model. It uses the session's current profile when the request is raised, and the journal records it. The strong tier is the first available profile in the list whose family differs from the requester's. When the host cannot establish the requester's family, a raised or referred request is rejected with `unavailable`. A different provider is not enough.

Usage of these turns is recorded as host usage. It is not charged to a run's budget, and no budget or limit blocks a turn.

A strong profile from a second family needs a noninteractive, tool-less reviewer for a provider other than Claude Code. That launch path is new.

### What changes from today

- The per-run decision limit and `--permission-limit` are removed.
- The reviewer is no longer a member of the run. The permission agent is a host service, and its decisions link to the run.
- The destructive flag no longer disqualifies a request. It raises it, and its accept needs a strong verdict.
- In a delegated workspace the owner is no longer asked about a request outside the five classes and `undeliverable`.
- A diagnostic turn's written cause no longer reaches a project manager or a mission coordinator.

## Documentation

`PRODUCT.md` and `AGENTS.md` change in the slice that activates the permission agent, so that neither describes behaviour the host does not have. `docs/teams.md` ("Delegating permission decisions"), `docs/security.md` ("Delegated team permission decisions") and `docs/cli.md` change with the slice that changes the behaviour they describe.

`PRODUCT.md`, in place of the four sentences from "Provider permissions remain with the owner unless" to "existing runs retain their pinned policy.":

> Provider permissions remain with the owner unless the owner records a delegation for a workspace. Under that delegation a separate permission agent decides one-shot requests from agent sessions in that workspace: it allows a request, or rejects it with a recorded reason. The permission agent is never the requesting agent and does none of the work. The host decides nothing itself: it applies only that agent's recorded decision for a current one-shot request, with stale-request and human-control checks. Five classes of request always need the owner's own answer: production or staging actions, new or external credentials, money, destructive operations outside the workspace, and global or account settings. The permission agent only answers requests. It cannot start work, instruct another agent, grant a persistent approval, or change its own policy. A request it cannot decide with confidence is rejected, and every decision is kept for the owner's review. A request it does not serve is handled as before: an interactive request waits for the owner, and a headless request outside its allowlist is refused. Owner-initiated workspace onboarding records the delegation by default; `--permissions off` opts out, and the owner can revoke it at any time.

`AGENTS.md`, in place of the sentence that starts "A strong coordinator may decide":

> A separate permission agent may decide current one-shot requests only under the owner's recorded workspace delegation, with guarded delivery; it never decides its own request, and the owner's five interrupt classes always need the owner's own answer.

## Verification

Focused tests protect the authority rules. Each one fails if the rule is removed:

- No request is allowed for a project with no delegation, after a revoke, under a retired authority, on a host that is not ready, or for a project of another repository grouped into a workspace after its delegation. A new checkout of a covered repository is admitted and recorded. A checkout with an opt-out is not admitted.
- For each of the five classes, a concrete request that matches its class rule reaches the owner with no model turn, cannot be allowed by a report, and is not replayed. A persistent-only approval and a workspace trust prompt reach the owner although they offer no one-shot choice.
- The light tier cannot produce a reject or an owner route. A host rule cannot produce an allow.
- A raised request never gets a light verdict. A request with the destructive flag is not delivered on a light verdict.
- The strong tier's family differs from the requester's, also on replay. With no such profile, or with a requester family that the host cannot establish, the result is `unavailable`.
- A notice, a recovery outcome and a run status contain no model text.
- The owner is pushed only in the situations of the notification table.
- An open reject reaches the next turn after a conversation rotation, a member replacement and a restart. An assignment with a reject is raised. A second repeat of one open reject locks the assignment with no model turn, also for a replacement member. Three unrelated rejects, or reviewer outages, do not lock. Reopening the reject ends the lock and allows nothing.
- An identical reject replays with no model turn. A reopened reject, a changed direction text, and an open reject newer than a recorded allow each stop the replay.
- An owner grant is used once, only by its session and only for its evidence, and never after an uncertain delivery.
- A permission agent turn cannot get its own request decided.
- A delivery whose result is unknown is not repeated after a restart.

One sandbox team run on the owner's host proves the product path at rollout: a member needs a command outside its allowlist, gets a decision, and the run finishes with no owner action.

## Delivery slices

| Slice | Content | Behaviour change |
|---|---|---|
| 1 | Workspace delegation record with its coverage rules, owner API and CLI, policy text and interrupt classes, permission journal, rate figures | None. Nothing reads the record yet. |
| 2 | `permissionAgent` configuration, model families, the readiness rule, and the noninteractive tool-less reviewer for a second provider | None. Nothing launches it yet. |
| 3 | Activation for team members: qualify, class rules, lock, replay, raise, light and strong turns, reject delivery with fixed notices, open rejects, delivery events, the notification rule, fixed recovery outcomes. The enrollment policy and the count limit are removed. `PRODUCT.md`, `AGENTS.md` and the two docs sections change here. | Team members in delegated workspaces. |
| 4 | Sessions outside team runs, with goal and mission coordinators | Every interactive session in a delegated workspace. |
| 5 | Spike, then the headless permission channel and the single-use owner grant | Headless sessions. |
| 6 | Owner review: `permissions log`, marks, digest entry, client views | Review surfaces. |

Slice 5 starts with a spike on the host's provider versions. It must show which mechanism lets a headless session wait for an outside decision, how long the provider waits, what the model sees after a deny, and that a deny rule still wins.

The amended `PRODUCT.md` text is the authority rule, and it is true from slice 3. Its coverage reaches every session kind after slices 4 and 5. Until then its sentence about a request that the agent does not serve describes the rest.

## Rollout on the owner's host

1. Deploy through the normal staged release. Deployment keeps its own authorization.
2. Configure the light profile and strong profiles from two families.
3. Record the delegation for every workspace that exists at that time with one owner-client command, and keep the list of saved policies that it replaced. The authority for this step is the owner's approval of 2026-11-14.
4. Run the sandbox proof from "Verification".
5. After slice 5, add the permission channel to the sandbox launch profile. Its allowlist and deny rules stay.

## Calls made by the builder, for the owner to confirm

- "Workspace" is read as a project group as the clients show it. A session whose project has no delegation stays with the owner.
- Decision 4 is read as: drop both the count limit and the spend fuse. The rate is tracked and shown, and nothing stops on it.
- A workspace created later gets the delegation by default when the owner onboards a repository into it, and `--permissions off` opts out. A repository that the owner groups into a delegated workspace later needs the delegation recorded again.
- `permissions delegate` replaces a saved opt-out or custom scope and prints what it replaced.
- The light tier can only allow or refer. Every reject and every owner route comes from the strong tier or a host rule.
- The requester receives a fixed notice and a code, never the model's reason. The reason is kept for the owner.
- An assignment that repeats one rejected request twice is locked until the owner reopens that reject or unlocks it. This is a targeted stop, added as a guardrail under decision 4.
- An opt-out on a project always wins over automatic coverage.
- When the host cannot establish a requester's model family, a request that needs the strong tier is rejected with `unavailable`.
- The class rules are the host's established predicates for the five classes. A wider match only raises the tier.
- A request that no qualifying model can review inside five minutes is rejected with `unavailable`. It does not wait for the owner.
- A dialog that the host cannot answer in either direction still goes to the owner.
- A headless request in an interrupt class is denied with `needs-owner` and pushed. The owner's approval becomes a single-use grant for that session and that exact request.

## Relation to other work

- Draft PR #106 (continuous autonomy) changes other paragraphs of `PRODUCT.md`. Its interrupt list for an autonomous project and its daily digest agree with this design: the five classes here are the permission requests among its "irreversible or external action" and "request for wider authority" reasons, and it already exempts a waiting permission decision from the spend fuse.
- Draft PR #111 stores a project's autonomy mode. The workspace delegation is a separate record. A supervised project can hold one.
- INF-153 and INF-159 built the reviewer that this design generalizes. INF-223 is the headless refusal that slice 5 removes.
