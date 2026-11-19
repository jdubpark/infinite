# Review feedback returns to delivered work (INF-324)

Date: 2026-11-19. Status: design for review, second draft after an independent review of the first. Nothing is built. Four decisions at the end are the owner's.

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

## Design

### 1. Which review counts

The host reads the pull request and decides with a pure function. No model reads the review to decide whether it counts.

The pull request must be the one in `run.pullRequest`, open, not from a fork, on the run's base branch, and on the delivery branch recorded for the run (section 4).

Of the reviews on it, the host considers only those by `config.github.reviewFeedback.ownerLogin` (compared without case) in the states `CHANGES_REQUESTED`, `APPROVED` or `DISMISSED`, and of those only the newest by submission time. A comment-only review neither starts nor cancels anything.

That newest review starts work when all of these hold:

1. Its state is `CHANGES_REQUESTED`.
2. It was submitted after review feedback was first enabled on this host (decision 4).
3. Its commit, the pull request's current head, and `run.pullRequest.headCommit` are the same commit, and `run.pullRequest.revision` is the run's current revision.
4. Its id is not in the run's handled list.
5. Its summary is not empty.
6. The run has accepted fewer than 3 reviews.

Every other case is recorded with its reason and starts nothing: `approved-seen`, `dismissed`, `stale-head`, `no-text`, `before-enable`, `limit`. Because only the newest review counts, a later approval or dismissal cancels an earlier request that has not started, and a handled list of 20 ids is enough: an id that old cannot be the newest again.

### 2. Reading reviews

The host polls. Webhooks stay disabled, as the GitHub App guide requires.

- **What is watched:** runs at `ready-for-review` in delivery mode `pr`, with a pull request recorded at the current revision and a workspace still present, that no goal owns. On 2026-11-19 the live host held five runs at `ready-for-review` with a pull request (a read-only count).
- **How:** one `gh pr view NUMBER --json state,isCrossRepository,baseRefName,headRefName,headRefOid,reviews --repo REPOSITORY` per watched run, through the command path and grant environment the host uses for its own Git operations. The grant carries the `pr` operation and no refs, so it can read and cannot write.
- **When:** every `pollMinutes` (default 5) on the source refresher's timer (`packages/host/src/project-source.ts:391-392`), never on the 500 ms team tick. A failed read is logged and retried at the next interval. It changes no run.
- **Text:** the review summary, bounded to 8,000 characters, with a note and the pull request link when it was longer. Inline comments are out of reach in the first build (decision 2). An empty summary is recorded as `no-text`, and the run's event asks for the changes in the review summary. A `no-text` review is read again at each poll, so adding a summary to it later counts.
- **When intake ends:** when the run's workspace is removed. The removal records one event: review feedback is no longer taken for this pull request, start a new mission for further changes.

### 3. Accepting a review once

When a review counts, the host writes an **intent** into the run's host-private record and saves it before doing anything else:

`{ reviewId, submittedAt, commit, text, requestId, targetRevision, state: "pending" | "applied" | "superseded" | "refused", reason? }`

`text` is the bounded summary as read at acceptance, and `requestId` is derived from the run id and the review id. The host then makes exactly the call the intent names (section 4 or 5), marks the intent `applied`, adds the review id to the handled list, and saves. Both calls already answer a repeated request id with the first result, so a crash between the two saves applies the review once.

Pending intents are drained at startup and at every poll, whatever the run's status is by then. Acceptance runs on the team service's queue, so it cannot interleave with another change to the run. An intent that waited (a host halt, a paused or blocked mission) is checked against GitHub again before it is applied: if the review is no longer the owner's newest, was dismissed, or the head moved, the intent becomes `superseded`. The accepted text is never replaced by a later edit of the review.

The run's view gains `reviewFeedback`, the newest 20 entries of `{ reviewId, state, submittedAt, receivedAt, outcome }`. It carries no review text.

### 4. A run the owner started directly

The intent's call is the existing `steer`, with the review summary as text and the source `{ kind: "github-review", id, name: "Your GitHub review" }`. Steering already advances the revision, keeps the integrated work, and replans from the current head. Four changes make a delivered run a sound place to continue:

- **Delivered means delivered at this revision.** The twelve guards change from "a pull request is recorded" to "a pull request is recorded at the run's current revision". `run.pullRequest` stays where it is, so every client keeps the link, and the run view says which revision it was delivered at.
- **The delivery target is the pull request's branch.** A `pull-request` report also records the branch the delivery was granted, and `teamDeliveryBranch` returns that branch while a pull request is recorded. The run never moves to another branch or a second pull request. For a record made before this change, the branch is taken from the first read of the pull request, and only when it is the run's branch or the branch its delivered head was published to.
- **The pull request moves only at delivery.** While a recorded pull request is older than the run's revision, head publication goes to `BRANCH-<8 hex>`, the form the host already uses when a push is rejected. The delivery member then pushes the reviewed commit to the pull request's branch, after the checks and the independent review pass. The owner never sees commits on the pull request that the independent reviewer has not approved.
- **The delivery prompt accepts that push.** Its fast-forward rule gains the heads this run delivered earlier.

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

One allowance makes the forward possible. Today `steer-subtask` is refused for a finished subtask. It is accepted for a finished subtask while the mission holds an unforwarded review direction for it, the subteam's run is at `ready-for-review` with a pull request at its current revision, and its workspace is present. The subtask returns to `running`, the steer is the existing team `steer` by the coordinator, and section 4's four changes apply. A reopened mission holds its subteams' workspaces again, because the retention hold reads the mission's status.

When the subteam is `ready-for-review` again the coordinator hears it as for any subtask and reports the mission's result.

### 6. What a review can and cannot change

A review is steering text and reaches as far as an owner steer does today. It can lead to a plan that touches other paths of the same repository, because an ordinary run has no path ceiling and this design adds none. It cannot change the repository, the delivery mode or target, the grants, the permission mode, or the limits on members and coordinator attempts. For a reopened mission it adds working time once (decision 1).

### 7. What the owner sees

- The run's event: "The owner requested changes on the pull request (review ID). The run continues from its delivered commit at revision N."
- The board item returns to the working column, and the mission's Slack thread shows the direction and the status as for any owner direction.
- On GitHub the pull request shows the new commits only when the run is `ready-for-review` again. The host posts no comment there in the first build.

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
| A goal's run | Not watched in the first build. Direction for a goal goes to the goal |

## Security

- **Who can trigger it:** only an account that GitHub shows as the configured owner login. By the documented server setup, agents reach GitHub through the App's installation token, the proxy has no command that submits a review, and an App cannot author a review as a user. This is read from the source and the deployment guide, not tested against the live server.
- **Residual risk where agents hold the owner's own GitHub credential** (a laptop): an agent could author such a review. Each forged review starts one continuation, at most three for a run, shaped by its text anywhere in the run's repository. The result still passes the checks, the independent review and the same delivery, and nothing merges. Leave the feature off on such a machine, or accept that bound.
- **Review text is direction, not a command.** The host never puts it into a command, a command prefix or a grant. Members act on it as they act on owner steering, under the permissions the run already has, and it passes the same redaction on outbound surfaces.
- **No new credential and no new write by the host.** The first build adds one read through an operation the proxy already allows.

## Build plan

1. Types and the pure decision: the intent, `reviewFeedback` on the run, and `reviewVerdict(run, pullRequest, ownerLogin, enabledAt)`. Unit tests on the table of section 1.
2. The team service: the twelve guards, the recorded delivery branch, publication to the side branch, and the delivery prompt's rule. Tests with the team fixture: a steer on a delivered run recovers from a blocked member, delivers to the same branch, and publishes nothing to it before the review passes.
3. The poller and the intents, with a fake `gh`. Tests: a replay after a simulated crash steers once; a review superseded while a halt holds it starts nothing. Runs the owner started directly are complete after this step.
4. The mission: `reviewDirection`, the reopen, the `steer-subtask` allowance and the coordinator's prompt lines. Tests in the mission fixture for each row of section 5's table.
5. Surfaces and documents (`docs/teams.md`, `docs/missions.md`, `docs/security.md`, `deploy/ubuntu/github-app.md`).

Steps 2 and 4 change the run and mission state machines and go to a strong implementer with independent review. Nothing ships enabled.

## Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | How much working time does a mission get when a review reopens it? | The mission's original `maxMinutes`, once per accepted review. It is a ceiling, and the limits on subtasks, members and coordinator attempts stay cumulative |
| 2 | Inline comments: add a narrow proxy read for a review's comments now, or ship summary-only first? | Summary-only first, and say so in the pull request description the delivery member writes. The proxy holds the installation token, so a new read deserves its own review and its own deploy |
| 3 | After the workspace is removed: restore it from the published branch, or stop taking reviews? | Stop in the first build. Restoring needs a fetch of a non-base ref into the mirror and a proof that the fetched commit is the recorded one. Build it when a review is actually lost to retention |
| 4 | A changes-requested review that is already on a pull request when the feature is turned on: act on it, or ignore it? | Ignore it. Turning a switch on should not start work on old pull requests |

The first draft asked whether a review on a mission's pull request should go straight to the subteam. It does not: on 2026-10-20 the owner set the rule that owner input for a mission goes to the coordinator, and this design follows it.

## Not verified

- The fields of one review in `gh pr view --json reviews` on the installed `gh` 2.103.0. The top-level fields used in section 2 exist (checked on this repository on 2026-11-19), and no pull request here has a review, so `id`, `author.login`, `state`, `submittedAt`, `body` and `commit.oid` are assumed. Confirm at build with a redacted fixture from a real review.
- How GitHub lists a dismissed review and an edited review in that field.
- Whether Linear tracking follows a mission that returns from `ready-for-review` to `working`.
- Whether `steer` treats a handoff run as it treats a run the owner started directly.
- Whether anything removes the `BRANCH-<8 hex>` branches the host publishes. This design leaves one per continued revision.
- The live server's credential isolation, beyond what the deployment guide documents.
