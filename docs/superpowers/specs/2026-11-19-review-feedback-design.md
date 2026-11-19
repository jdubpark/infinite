# Review feedback returns to delivered work (INF-324)

Date: 2026-11-19. Status: design for review, fourth draft. An independent reviewer read four drafts. Its fourth read found the third's four findings resolved and asked for one statement, added here and not reviewed again: a review counts as current at the host's last read of GitHub. Nothing is built. The design recommends not building it yet: the host's records hold no run this design would watch (see "How often it would fire"). Six decisions at the end are the owner's.

## Intent

On 2026-11-19 the owner accepted this change from the Vercel Board study:

> Your "changes requested" review on a run's pull request starts a follow-up attempt from that pull request, with the review as direction. Only your GitHub login counts, as with Slack. An approval merges nothing.

Today a `pr` delivery ends at `ready-for-review`. The owner reads the pull request on GitHub, and anything the owner wants changed is typed again somewhere else. For a mission that means a new subtask or mission that starts from the base branch and knows nothing of the first one. GitHub is the one place where the owner's identity is verified by someone other than the host, so a review there is the strongest direction the host can receive.

### The rule

**A review is owner direction, and it enters where owner direction enters today.** For a run the owner started directly, that is the run's steering. For a mission's run, that is the mission's coordinator. The work continues in the same run from its delivered commit, and the pull request's branch moves only after the checks and the independent review pass again. Nothing on GitHub approves, merges, or grants anything.

## Current state

Observed on `main` at `c96e361e`:

- **A `pr` delivery records a pull request and stops.** The delivery member's `pull-request` report sets `run.pullRequest = { revision, headCommit, pullRequestUrl, summary, reportedAt }` and `run.status = "ready-for-review"` (`packages/host/src/teams.ts:5476-5484`). The host checks that the URL belongs to the configured repository (`:5445-5450`); it does not read the remote.
- **No host code reads a review.**
- **A delivered run the owner started directly already accepts steering.** `TeamService.steer` refuses a delivery attempt in flight, a merge receipt, a removed workspace, and the steering limits of 20 items and 32 KiB (`teams.ts:1693-1698`). A `pull-request` report clears the attempt (`:5477`), so a steer on a delivered run advances the revision and replans from the current head.
- **Such a revision runs without recovery.** Twelve guards in ten functions read `run.pullRequest` as "this run has delivered" and switch off automatic recovery, delivery recovery, verification reconciliation, and member retirement for the rest of the run (`teams.ts:380`, `:394`, `:767`, `:1776`, `:1868`, `:1923`, `:2722`, `:2766`, `:2786`, `:2848`, `:2890`, `:3713`). The web, the phone, Slack and Understanding read the same field for the pull request link (`apps/web/src/teams.tsx:448`, `packages/host/src/intake-slack.ts:376`, `packages/host/src/understanding.ts:310`).
- **A mission's run takes owner input only through the coordinator.** Owner direction goes to the coordinator, which forwards it with `steer-subtask` (`docs/missions.md:276-283`). A mission at `ready-for-review` refuses direction (`packages/host/src/missions.ts:113`, `:590`), and `steer-subtask` is refused for a finished subtask with "dispatch a follow-up subtask for finished work" (`missions.ts:1542-1543`). A finished mission no longer holds its subteams' workspaces (`missions.ts:238-241`).
- **Heads are published before review.** With `publishHeads` (on by default, `teams.ts:1121-1123`) the host pushes the integrated head to `run.branch` before the reviewer starts, and to `run.branch-<8 hex>` when that push is rejected (`teams.ts:1139-1165`). The delivery branch is the published branch when it holds the current head, otherwise `run.branch` (`packages/host/src/team-prompts.ts:22-26`), and the delivery member's grant covers exactly that branch (`packages/host/src/github-grants.ts:158-161`, `teams.ts:5143`).
- **The delivery prompt allows one kind of fast-forward.** It pushes "only if its remote head is unchanged or is a fast-forward from an earlier repair head recorded for this run" (`team-prompts.ts:342`). A delivered head is not on that list.
- **The proxy can read a pull request and cannot write without a ref.** `gh pr view NUMBER --json FIELDS` is allowed under the `pr` grant operation; every write needs the head branch inside the grant's refs, and a grant without refs matches none (`scripts/github-proxy.mjs:87-88`, `:667-700`, `:747-769`). `gh api` is refused, so a review's inline comments are not readable.
- **An ordinary run has no path ceiling.** Only a goal run's plan is checked against allowed paths (`teams.ts:5304-5305`); otherwise each revision's plan sets the paths.
- **A workspace is kept 24 hours after `ready-for-review`** by default (`reviewHours`), longer while a retention hold applies. The run record stays.
- **Slack intake accepts an outside event once.** It stores each event by id, saves the call it chose before performing it, replays exactly that call, and drains saved calls at startup (`packages/host/src/intake-types.ts:56-62`, `packages/host/src/intake-slack.ts:216-218`, `:672-687`).

## How often it would fire

Read-only counts from the live host on 2026-11-19, over the 29 runs it holds (the oldest is 32 days old):

| Outcome | Runs |
| --- | --- |
| A pull request recorded and not merged: what this design would watch | 0 |
| Merged by the delivery member after the independent review (delivery mode `merge`) | 15 |
| `ready-for-review` with no pull request recorded | 5 (3 goal cycles, 2 runs the owner started directly) |
| Cancelled, blocked, or ended without a change | 9 |

None of the 29 runs belongs to a mission.

These records hold no run this design would watch. The delivered runs on this host were merged by their delivery member, so the pull request is already merged when the owner reads it, and this design watches open pull requests only.

The count reads the host's records, not GitHub. A `merge` delivery that opened a pull request and then blocked before merging, or a `pr` delivery whose report was lost, leaves an open pull request that no record names (`packages/host/src/team-prompts.ts:345-347`, `teams.ts:5476-5481`). The count also covers only the runs the host still holds; runs removed under retention are not in it.

## Design

### 1. Which review counts

The host reads the pull request and decides with a pure function. No model reads the review to decide whether it counts.

The pull request must be the one in `run.pullRequest`, open, not from a fork, on the run's base branch, and on the delivery branch recorded for the run (section 4). The run is one the owner started directly or a mission's run. Goal runs and handoff runs are not watched.

Of the reviews on it, the host considers only those by `config.github.reviewFeedback.ownerLogin` (compared without case) in the states `CHANGES_REQUESTED`, `APPROVED` or `DISMISSED`, and of those only the newest by submission time, and by review id when two times are equal. A comment-only review neither starts nor cancels anything.

That newest review starts work when all of these hold:

1. Its state is `CHANGES_REQUESTED`.
2. It was submitted after review feedback was last switched on for this host (decision 4).
3. Its commit, the pull request's current head, and `run.pullRequest.headCommit` are the same commit, and `run.pullRequest.revision` is the run's current revision.
4. Its id is not in the run's handled list.
5. Its summary is not empty.
6. The run has accepted fewer than 3 reviews.

Every other case is recorded with its reason and starts nothing: `approved-seen`, `dismissed`, `stale-head`, `no-text`, `before-enable`, `limit`. Because only the newest review counts, a later approval or dismissal cancels an earlier request that has not started, and a handled list of 20 ids is enough: an id that old cannot be the newest again. Only an applied review enters the handled list, so a `no-text` review still counts when a summary is added to it.

### 2. Reading reviews

The host polls. Webhooks stay disabled, as the GitHub App guide requires.

- **What is watched:** runs at `ready-for-review` in delivery mode `pr`, with a pull request recorded at the current revision and a workspace still present, that neither a goal nor a handoff owns. On 2026-11-19 the live host held no such run.
- **How:** one `gh pr view NUMBER --json state,isCrossRepository,baseRefName,headRefName,headRefOid,reviews --repo REPOSITORY` per watched run, through the command path and grant environment the host uses for its own Git operations. The grant carries the `pr` operation and no refs, so it can read and cannot write.
- **When:** every `pollMinutes` (default 5) on the source refresher's timer (`packages/host/src/project-source.ts:391-392`), never on the 500 ms team tick. A failed read is logged and retried at the next interval. It changes no run.
- **Text:** the review summary, bounded to 8,000 characters, with a note and the pull request link when it was longer. Inline comments are out of reach in the first build (decision 2). An empty summary is recorded as `no-text`, and the run's event asks for the changes in the review summary. A `no-text` review is read again at each poll, so adding a summary to it later counts.
- **When intake ends:** when the run's workspace is removed. The removal records one event: review feedback is no longer taken for this pull request, start a new mission for further changes.

### 3. Accepting a review once

When a review counts, the host writes an **intent** into the run's host-private record and saves it before doing anything else:

`{ reviewId, submittedAt, commit, text, requestId, targetRevision, state: "pending" | "applied" | "superseded" | "refused", reason? }`

`text` is the bounded summary as read at acceptance, and `requestId` is derived from the run id and the review id. The intent holds everything its call needs: for a run the owner started directly, the text and the team revision it applies to; for a mission's run, also the mission, the subtask and the mission revision. `targetRevision` is the team revision in both cases.

Applying an intent takes three steps, and no step holds one service's queue while it waits for the other's. A mission tick already waits for team changes (`packages/host/src/missions.ts:1059`), so a team task that waited for the mission queue could wait forever.

1. On the team queue: check the review (section 1), write the intent as `pending`, save.
2. On no queue: make the call the intent names (section 4 or 5) with the saved payload.
3. On the team queue: mark the intent `applied`, or `refused` with the destination's reason, add an applied review to the handled list, and save.

Pending intents are drained at startup and at every poll, whatever the run's status is by then, and one drain runs at a time for a run. A drain never makes the call blind. Both destinations keep a receipt for each request id they applied, and each gains a read of that receipt that changes nothing. For each pending intent the drain:

1. Reads the destination's receipt for the intent's request id. A receipt means the call took effect: the intent is marked `applied` and is never judged again.
2. Without a receipt (a host halt, a paused or blocked mission), asks GitHub. When the review is no longer the owner's newest, was dismissed, or the head moved, the intent becomes `superseded` and no call is made.
3. Otherwise makes the call with the saved payload and acknowledges it.

A call that cannot run yet, because the mission is paused, leaves the intent `pending`. `refused` records only the destination's final answer. The accepted text is never replaced by a later edit of the review.

GitHub and the host's record cannot change together. A review counts as current at the host's last successful read of GitHub. An approval or a dismissal after that read, and before the steer runs, does not stop the steer. The same holds for the check before a mission's forward (section 5).

**A defect in `steer` must be fixed first (INF-331).** Today `steer` writes its request receipt (`teams.ts:1699`) and then waits for the permission invalidation, which saves the run (`teams.ts:2037`, `:2048`) before the revision and the text change (`:1706`). A host that stops between those saves keeps the receipt without the steer, and a repeated request id is then answered as if it had been applied. The fix records the receipt in the same save that advances the revision. Without it the three steps above do not apply a review exactly once.

The run's view gains `reviewFeedback`, the newest 20 entries of `{ reviewId, state, submittedAt, receivedAt, outcome }`. It carries no review text.

### 4. A run the owner started directly

The intent's call is the existing `steer`, with the review summary as text and the source `{ kind: "github-review", id, name: "Your GitHub review" }`. Steering already advances the revision, keeps the integrated work, and replans from the current head. Six changes make a delivered run a sound place to continue:

- **Delivered means delivered at this revision, except for delivery recovery.** Nine of the twelve guards change from "a pull request is recorded" to "a pull request is recorded at the run's current revision": `teams.ts:380`, `:394`, `:767`, `:1868`, `:1923`, `:2766`, `:2786`, `:2890`, `:3713`. The three that start or reconcile delivery recovery keep today's test (`:1776`, `:2722`, `:2848`), because that recovery assumes no pull request exists yet (below). `run.pullRequest` stays where it is, so every client keeps the link, and the run view says which revision it was delivered at.
- **The delivery target is the pull request's branch.** A `pull-request` report also records the branch the delivery was granted, and `teamDeliveryBranch` returns that branch while a pull request is recorded. The run never moves to another branch or a second pull request. For a record made before this change, the branch is taken from the first read of the pull request, and only when it is the run's branch or the branch its delivered head was published to.
- **The pull request moves only at delivery.** While a recorded pull request is older than the run's revision, head publication goes to `BRANCH-<8 hex>`, the form the host already uses when a push is rejected. The delivery member then pushes the reviewed commit to the pull request's branch, after the checks and the independent review pass. The owner never sees commits on the pull request that the independent reviewer has not approved.
- **The delivery prompt accepts that push.** Its fast-forward rule gains the heads this run delivered earlier.
- **Delivery recovery learns that a pull request exists.** Three things in it assume a first delivery. The delivery prompt tells the member to report `no-publication` when the host's published branch has no pull request and the base moved (`team-prompts.ts:385-386`); in a continued revision that branch is the side branch, which never has one. A `no-publication` report rebuilds the workspace from the moved base (`teams.ts:5360-5384`, `:5414`), which drops the commits the existing pull request needs for a fast-forward. And delivery evidence may name the run's branch or the delivery branch (`teams.ts:451`). With a pull request recorded, the host refuses `no-publication`, accepts evidence only for the recorded branch and URL, and the prompt says that the side branch is a checkpoint and names the pull request. A delivery failure in a continued revision therefore blocks the run for the owner. It does not recover by itself in the first build.
- **An earlier delivery recovery does not block the next delivery.** When a delivery recovery ran before the first delivery, its record stays on the run as `complete` (`teams.ts:5483`). Any record that is not `planning` at the current revision, head and policy refuses a later delivery report (`teams.ts:5442-5444`), so clearing its status would not be enough. A steer that advances the revision removes the active record and keeps the number of recoveries already used in a separate counter, so the limit on recoveries stays cumulative.

The delivery member reports `pull-request` with the same URL, and the run is `ready-for-review` again with the new head.

### 5. A run that a mission owns

The owner talks only to the coordinator, so the intent's call goes to the mission: a new `MissionService.reviewDirection` with the request id, the subtask, the pull request URL and the text. It is one saved mission change:

| Mission status | Effect |
| --- | --- |
| `planning`, `working`, `needs-input` | The direction is recorded as owner steering with the review as its source, and reaches the coordinator's inbox |
| `ready-for-review` | The mission reopens: its result moves to a history list, the status becomes `working`, the deadline is set to a new window (decision 1), and the direction is recorded as above. Follow-ups cancelled by the earlier result stay cancelled |
| `paused`, `blocked` | The intent stays pending and is applied when the mission is live again. The mission's event says a review is waiting |
| `cancelled` | The intent is `refused` |

The inbox message carries the owner's words unchanged, names the subtask and the pull request, and tells the coordinator that `steer-subtask` on that subtask continues it from its delivered commit and updates the same pull request. The coordinator decides, as it does for any owner direction: forward it, ask the owner, or do something else in scope. Waking it costs one coordinator attempt, inside the mission's limit of 60.

One allowance makes the forward possible. Today `steer-subtask` is refused for a finished subtask, and the queued steer behind it would be lost anyway: `applyOps` drops a steer for a settled team (`missions.ts:1053`) and rebinds a stale steer to the team's newer revision (`missions.ts:1065-1067`), which would send an old review to a later delivery. So the forward is its own queued operation, `review-forward`. It carries the review id, the delivered revision and head it applies to, the exact text, a stable request id, and an authorization that works once. The host accepts it for a finished subtask while the mission holds an unforwarded review direction for that subtask, the subteam's run is at `ready-for-review` with a pull request at that revision and head, and its workspace is present. `applyOps` then, in this order:

- reads the team's receipt for the operation's request id. A receipt means the steer already happened: the authorization is marked used and the operation ends, whatever GitHub or the team says by then. Without this, a host that stopped after the steer would refuse its own forward, because the steer advanced the revision;
- waits while another run holds the repository, as `schedule` does for a new subtask (`missions.ts:892-899`);
- checks GitHub once more, immediately before the steer: the review is still the owner's newest, it is not dismissed, and the head has not moved (decision 5). Otherwise the operation ends as `superseded` and the coordinator is told;
- refuses a team whose revision or head is no longer the one the operation names, and never rebinds it;
- performs the existing team `steer` by the coordinator with the saved text and request id, and marks the authorization used after the steer succeeded. The subtask's status follows the team's as it does today (`missions.ts:973-976`), so nothing sets it by hand.

Section 4's changes apply to the subteam's run. A reopened mission holds its subteams' workspaces again, because the retention hold reads the mission's status.

**The mission's intake record reopens with it.** A mission's intake record becomes `finished` at its first result (`packages/host/src/intake.ts:687-695`). After that Slack answers "This request has finished" (`packages/host/src/intake-slack.ts:705`), and a later result records no outcome, because the observer requires a started record (`intake.ts:689`). Reopening a mission returns its intake record to `started` in the same change, keeps the earlier messages and the earlier outcome, and keys the next outcome by the result's revision. Linear's workflow state for the issue is not changed by this.

When the subteam is `ready-for-review` again the coordinator hears it as for any subtask and reports the mission's result.

### 6. What a review can and cannot change

A review is steering text and reaches as far as an owner steer does today. It can lead to a plan that touches other paths of the same repository, because an ordinary run has no path ceiling and this design adds none. It cannot change the repository, the delivery mode or target, the grants, the permission mode, or the limits on members and coordinator attempts. For a reopened mission it adds working time once (decision 1).

### 7. What the owner sees

- For a run the owner started directly, the run's event: "The owner requested changes on the pull request (review ID). The run continues from its delivered commit at revision N." For a mission's run, the mission's event at acceptance is "The owner's review was delivered to the coordinator", and the run's event appears only after the coordinator's forward has steered the run.
- The board item returns to the working column, and the mission's Slack thread shows the direction and the status as for any owner direction.
- On GitHub the pull request shows the new commits when the delivery member pushes them: after the checks and the independent review passed, and shortly before the run is `ready-for-review` again. The host posts no comment there in the first build.

### 8. Configuration

`config.github.reviewFeedback = { enabled: false, ownerLogin, pollMinutes: 5 }`. Off by default. `ownerLogin` has no default and the feature refuses to start without it. The value lives in private runtime configuration, never in a tracked file.

## Limits and failure cases

| Case | Behaviour |
| --- | --- |
| Review arrives after the workspace was removed | Not read. The removal's event already said intake ended (decision 3) |
| Pull request head is not the delivered head | `stale-head`. Nothing starts |
| Pull request closed, merged, or from a fork | The run leaves the watched set |
| Review summary empty | `no-text`, read again at each poll |
| Fourth review on one run | `limit`: start a new mission with consolidated direction |
| Steering limit reached | The intent is `refused` with the steer's own message |
| Review submitted before the feature was enabled | `before-enable` |
| GitHub unreachable or rate limited | No state change; retried at the next interval. The cost is one read per watched run per interval |
| Host halted | Intents wait and are checked against GitHub again before they are applied |
| A goal's run or a handoff's run | Not watched. Direction for a goal goes to the goal; a handoff's run belongs to the session that handed it off |
| Delivery fails in a continued revision | The run blocks for the owner. Automatic delivery recovery stays off while a pull request is recorded |
| The owner approves or dismisses the review after it reached the coordinator and before the forward | The forward ends as `superseded` (decision 5) |

## Security

- **Who can trigger it:** only an account that GitHub shows as the configured owner login. By the documented server setup, agents reach GitHub through the App's installation token, the proxy has no command that submits a review, and an App cannot author a review as a user. This is read from the source and the deployment guide, not tested against the live server.
- **Residual risk where agents hold the owner's own GitHub credential** (a laptop): an agent could author such a review. Each forged review starts one continuation, at most three for a run, shaped by its text anywhere in the run's repository. The result still passes the checks, the independent review and the same delivery, and nothing merges. Leave the feature off on such a machine, or accept that bound.
- **Review text is direction, not a command.** The host never puts it into a command, a command prefix or a grant. Members act on it as they act on owner steering, under the permissions the run already has, and it passes the same redaction on outbound surfaces.
- **No new credential and no new write by the host.** The first build adds one read through an operation the proxy already allows.

## When to build

Build it when runs stop at an open pull request for the owner's review. Today the host's records hold no such run (see "How often it would fire"). That is decision 0 below. Two things do not wait for it:

- INF-331, the receipt order in `steer`, is a defect today for every steer that is retried.
- The owner's review of merged work reaches nothing by itself. `steer` refuses a run with a merge receipt (`teams.ts:1693`). Inside a mission a later subtask can already build on a merged one: the mission picks the merged predecessor, and the new run starts from its merge commit (`missions.ts:946-951`, `teams.ts:1541-1550`). The missing part is the intake: reading the owner's review of a merged pull request and turning it into such a follow-up. It is not designed here.

## Build plan

1. Types and the pure decision: the intent, `reviewFeedback` on the run, and `reviewVerdict(run, pullRequest, ownerLogin, enabledAt)`. Unit tests on the table of section 1.
2. The team service, after INF-331: the nine guards, the recorded delivery branch, publication to the side branch, the delivery prompt's rules, the refusal of `no-publication` with a recorded pull request, and the delivery recovery record across a steer. Tests with the team fixture: a steer on a delivered run recovers from a blocked member, delivers to the same branch, publishes nothing to it before the review passes, and blocks for the owner when its delivery fails.
3. The poller and the intents in their three steps, with a fake `gh`. Tests: a replay after a stop between any two saves steers once; an intent whose call already took effect is acknowledged without a second read of GitHub; a review superseded while a halt holds it starts nothing. Runs the owner started directly are complete after this step.
4. The mission: `reviewDirection`, the reopen with its intake record, the `review-forward` operation and the coordinator's prompt lines. Tests in the mission fixture for each row of section 5's table, for a forward to a team whose head moved, and for a forward while another run holds the repository.
5. Surfaces and documents (`docs/teams.md`, `docs/missions.md`, `docs/security.md`, `deploy/ubuntu/github-app.md`).

Steps 2 and 4 change the run and mission state machines and go to a strong implementer with independent review. Nothing ships enabled.

## Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| 0 | Should runs stop at an open pull request for your review? On this host the delivered runs are merged after the independent review, so the host's records hold no run this design would watch | Decide per project. Where your review should be the gate, set that project to delivery mode `pr` and build this. Where merging after the independent review is right, this design does not apply, and taking your review of merged work needs its own design (see "When to build") |
| 1 | How much working time does a mission get when a review reopens it? | The mission's original `maxMinutes`, once per accepted review. It is a ceiling, and the limits on subtasks, members and coordinator attempts stay cumulative |
| 2 | Inline comments: add a narrow proxy read for a review's comments now, or ship summary-only first? | Summary-only first, and say so in the pull request description the delivery member writes. The proxy holds the installation token, so a new read deserves its own review and its own deploy |
| 3 | After the workspace is removed: restore it from the published branch, or stop taking reviews? | Stop in the first build. Restoring needs a fetch of a non-base ref into the mirror and a proof that the fetched commit is the recorded one. Build it when a review is actually lost to retention |
| 4 | A changes-requested review that is already on a pull request when the feature is turned on: act on it, or ignore it? | Ignore it, counting from the last time the feature was switched on. Turning a switch on should not start work on old pull requests |
| 5 | You approve or dismiss your review after it reached the coordinator and before the coordinator forwarded it: does the forward still run? | No, when the host's last read of GitHub shows it. The host checks GitHub once more immediately before it steers the subteam, and ends the forward as superseded. A change after that read does not stop the steer. For a run you started directly the steer follows acceptance at once. If a halt holds it, the same check runs before the steer is made |

The first draft asked whether a review on a mission's pull request should go straight to the subteam. It does not: on 2026-10-20 the owner set the rule that owner input for a mission goes to the coordinator, and this design follows it.

## Not verified

- The fields of one review in `gh pr view --json reviews` on the installed `gh` 2.103.0. The top-level fields used in section 2 exist (checked on this repository on 2026-11-19), and no pull request here has a review, so `id`, `author.login`, `state`, `submittedAt`, `body` and `commit.oid` are assumed. Confirm at build with a redacted fixture from a real review.
- How GitHub lists a dismissed review and an edited review in that field.
- Whether Linear tracking follows a mission that returns from `ready-for-review` to `working`.
- Whether GitHub accepts a changes-requested review on a merged pull request. This design watches open pull requests only.
- INF-331 is confirmed by reading the code, not by a test.
- That every caller of `applyOps` holds the mission queue. The queue rule in section 3 does not depend on it.
- The counts in "How often it would fire" cover the runs the host still holds, and they read the host's records, not GitHub.
- Neither destination has a receipt read today. The design adds one to each.
- Whether anything removes the `BRANCH-<8 hex>` branches the host publishes. This design leaves one per continued revision.
- The live server's credential isolation, beyond what the deployment guide documents.
