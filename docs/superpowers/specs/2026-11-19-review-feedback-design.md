# Review feedback returns to delivered work (INF-324)

Date: 2026-11-19. Status: design for review. Nothing is built. Four decisions at the end are the owner's.

## Intent

On 2026-11-19 the owner accepted this change from the Vercel Board study:

> Your "changes requested" review on a run's pull request starts a follow-up attempt from that pull request, with the review as direction. Only your GitHub login counts, as with Slack. An approval merges nothing.

Today a `pr` delivery ends at `ready-for-review`. The owner reads the pull request on GitHub, and anything the owner wants changed has to be typed again as a new mission or run that starts from the base branch and knows nothing of the first one. GitHub is the one place where the owner's identity is verified by someone other than the host, so a review there is the strongest direction the host can receive.

### The rule

**A review records direction. The host continues the same run. Nothing on GitHub approves, merges, or widens anything.**

A changes-requested review from the configured owner login becomes owner direction for the run that opened the pull request. The run continues from its delivered commit under a new revision, passes the same checks and independent review, and pushes a fast-forward to the same branch, so the same pull request shows the result. An approving review, a comment, and any review by another login start nothing.

## Current state

Observed on `main` at `c96e361e`:

- **A `pr` delivery records a pull request and stops.** The delivery member's `pull-request` report sets `run.pullRequest = { revision, headCommit, pullRequestUrl, summary, reportedAt }` and `run.status = "ready-for-review"` (`packages/host/src/team-types.ts:757`, `packages/host/src/teams.ts`, the `pull-request` branch of `consume`). The record is the agent's report; the host does not read the remote.
- **No host code reads a review.** A search of `packages/host/src`, `scripts` and `deploy` for `reviewDecision`, `pull_request_review`, review or comment routes finds only the sentence in `deploy/ubuntu/github-app.md` that keeps webhooks disabled.
- **A delivered run takes no direction.** A team `steer` is refused after a delivery attempt or receipt (`teams.ts:1693`), and a mission accepts direction only while `planning`, `working` or `needs-input` (`packages/host/src/missions.ts:113`, `:590`), so a mission at `ready-for-review` refuses it.
- **A blocked run can already continue in place.** `TeamService.continueRun` (`teams.ts:2084`) keeps the integrated work, saves the old plan and review as a continuation, advances the revision, records the owner's text as steering, and replans from `run.headCommit`. It refuses a run with a delivery attempt or receipt, and a run whose workspace was removed.
- **The delivery prompt already allows a fast-forward.** In `pr` mode the member pushes the delivery branch at exactly the reviewed commit and opens or reuses a pull request, and "if the branch exists, allow only an unchanged head or a fast-forward from an earlier repair head recorded for this run" (`packages/host/src/team-prompts.ts:338-345`).
- **The proxy can already read a review.** `gh pr view NUMBER --json FIELDS` is allowed under the `pr` grant operation for every pull request of the granted repository; writes need the pull request's head branch to be inside the grant's refs (`scripts/github-proxy.mjs`, `GH_COMMANDS` and `resolvePullRequest`). `gh api` is refused, so a review's inline comments are not readable today.
- **A workspace is kept 24 hours after `ready-for-review`** by default (`reviewHours`, `team-types.ts:24-35`); the run record stays.
- **Slack intake accepts an outside event once.** It stores each event by id, saves the mission call it chose before performing it, and replays exactly that call (`packages/host/src/intake-types.ts:56-62`, `packages/host/src/intake-slack.ts`, `drain` and `apply`).

## Design

### 1. Which review counts

A review counts when all of these hold. Each is a host check on data read from GitHub, never a model's reading.

1. The pull request is the one in `run.pullRequest.pullRequestUrl`, it is open, and it belongs to the run's pinned delivery repository.
2. The review's state is `CHANGES_REQUESTED`.
3. The review's author login equals `config.github.reviewFeedback.ownerLogin`, compared without case.
4. The review's commit equals `run.pullRequest.headCommit`. A review of an older commit, or of a commit somebody pushed to the branch outside the run, is recorded as `stale-head` and starts nothing.
5. The review id has not been recorded for this run.
6. It is the newest such review. Older unhandled ones are recorded as `superseded`.

An approval is recorded as seen and changes no state. Merging stays the owner's action on GitHub, or the `merge` delivery mode's, exactly as today.

### 2. Reading reviews

The host polls. Webhooks stay disabled, as the GitHub App guide requires.

- **What is watched:** runs in `ready-for-review` with a `pullRequest` record, delivery mode `pr`, and a retained workspace. The set is small: on 2026-11-19 the live host held five such runs.
- **How:** one `gh pr view NUMBER --json state,headRefOid,reviews --repo REPOSITORY` per watched run, through the same command path and grant environment the host uses for its own Git operations. The grant carries the `pr` operation and no refs, so it can read and cannot write (to confirm at build: `refAllowed` with no refs).
- **When:** every `pollMinutes` (default 5), in the existing source refresher's timer, never on the 500 ms team tick. A failed read is logged and retried at the next interval; it changes no run.
- **What is read:** each review's id, author login, state, commit and body. The body is bounded to 8,000 characters when it becomes direction, with a note and the pull request link when it was longer.

Inline comments are out of reach in the first build. A review with an empty body is recorded as `no-text` and the run's event says the summary was empty and that changes must be written in the review summary. Decision 3 covers the proxy change that would lift this.

### 3. Accepting a review once

The run record gains `reviewFeedback`: a bounded list (20) of `{ reviewId, state, commit, submittedAt, receivedAt, outcome, handledAt? }` with `outcome` one of `continued`, `approved-seen`, `stale-head`, `superseded`, `no-text`, `refused`. The host writes the entry with the continuation request id it will use, saves the record, then performs the continuation. A crash between the two replays the same request id, so a review continues a run at most once. This is the Slack intake's pattern.

### 4. The review continuation

A new owner action on `TeamService`, built on `continueRun`'s body rather than beside it:

- **Preconditions:** status `ready-for-review`; `run.pullRequest` at the current revision and head; no delivery attempt in flight; every member stopped; no open permission decision; workspace present and clean at `run.headCommit`; member budget not exhausted; fewer than 3 review continuations so far.
- **Effect:** the same as a continuation of a blocked run, with three differences. The reason is "The owner requested changes on the pull request." The steering entry carries the review body and its source (`{ kind: "github-review", reviewId, pullRequestUrl }`). The delivered pull request moves from `run.pullRequest` into the continuation it belongs to, so the guards that protect a recorded delivery see none pending, and the delivered head joins the heads the delivery prompt lists as allowed fast-forward bases.
- **After it:** the project manager replans with the earlier plan, the earlier review, and the owner's direction in its context. Checks and the independent reviewer run on the new head. The delivery member pushes the same branch as a fast-forward and reports `pull-request` with the same URL. The run is `ready-for-review` again.

A review cannot change the run's objective scope, allowed paths, permissions, budgets or delivery policy. It is steering text under the pins the run already has.

### 5. Runs owned by a mission

A mission at `ready-for-review` holds finished subtasks, and its coordinator has stopped. When a subtask's run takes a review continuation, the host:

1. sets the subtask back to `running` and the mission to `working`,
2. gives the mission a working window (decision 2),
3. puts one message in the coordinator's inbox: the subtask, the pull request, and that the subteam is continuing from its delivered commit under the owner's review.

The coordinator does not choose whether the review applies and does not reword it: the review goes to the subteam as written. The coordinator keeps what it owns, which is recovery and the mission's next result once the subtask finishes. Decision 1 is the alternative.

### 6. What the owner sees

- The run's event: "The owner requested changes on the pull request (review ID). The run continues from its delivered commit at revision N."
- The board item returns to the working column; the mission's Slack thread and Linear issue get one line with the pull request link.
- On GitHub, new commits appear on the same pull request. The host posts no comment there in the first build.

### 7. Configuration

`config.github.reviewFeedback = { enabled: false, ownerLogin, pollMinutes: 5 }`. Off by default. `ownerLogin` has no default and the feature refuses to start without it. The value lives in private runtime configuration, never in a tracked file.

## Limits and failure cases

| Case | Behaviour |
| --- | --- |
| Workspace removed (review arrives after 24 hours) | Recorded as `refused` with the reason; the event tells the owner to start a new mission. Decision 4 covers restoring from the published branch |
| Branch head differs from the run's record | `stale-head`; nothing starts |
| Pull request closed or merged | The run leaves the watched set |
| Review body empty | `no-text`; nothing starts |
| Fourth review on one run | `refused`: start a new mission with consolidated direction |
| Steering limit reached (20 items or 32 KiB) | `refused`, same message as `continueRun` |
| GitHub unreachable or rate limited | No state change; retried next interval. Cost is one read per watched run per interval |
| Host paused by a halt | Reviews are recorded and held; the continuation runs after the release, as other owner input does |

## Security

- **Who can trigger it:** only an account that GitHub shows as the configured owner login. On the server, agents reach GitHub through the App's installation token, and an App cannot author a review as a user, so an agent cannot forge one there.
- **Residual risk on a machine where agents hold the owner's own GitHub credential** (a laptop): an agent could author such a review. The effect is bounded: it starts one continuation of a run that still passes checks, independent review and the same delivery, with no merge and no wider scope. Leave the feature off on such a machine, or accept that bound.
- **Review text is untrusted direction.** It is treated as the owner's steering is today: it enters prompts as owner direction, passes the same redaction on outbound surfaces, and never reaches a shell or a grant.
- **No new credential and no new write.** The first build adds one read through an operation the proxy already allows.

## Build plan

1. Types and the pure decision: `reviewFeedback` on the run, and `reviewVerdict(run, reviews, ownerLogin)` returning what to do with each review. Unit tests on the table in section 1.
2. The continuation in `TeamService`, sharing `continueRun`'s body; the delivery prompt's allowed heads; tests with the team fixture and a fake `gh`.
3. The poller in the source refresher, with the once-only record; a test that a replay after a simulated crash continues once.
4. The mission reopen and the coordinator message; tests in the mission fixture.
5. Surfaces and documents (`docs/teams.md`, `docs/missions.md`, `docs/security.md`, `deploy/ubuntu/github-app.md`).

Steps 2 and 4 change run and mission state machines and go to a strong implementer with independent review. Nothing ships enabled.

## Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Does a review on a mission's pull request go straight to the subteam, or to the coordinator as owner direction that it then forwards? | Straight to the subteam, with the coordinator informed. It keeps the owner's words intact and costs no coordinator turn. The coordinator still owns recovery |
| 2 | How much working time does a reopened mission get? | The mission's original `maxMinutes`, recorded as an extension caused by the review, once per review |
| 3 | Inline comments: add a narrow proxy read (`pulls/NUMBER/reviews/ID/comments` for granted repositories) now, or ship summary-only first? | Summary-only first, and say so in the pull request description the delivery member writes. The proxy holds the installation token, so a new read deserves its own review and its own deploy |
| 4 | After the workspace is removed: restore it from the published branch, or refuse? | Refuse in the first build. Restoring needs a fetch of a non-base ref into the mirror and a proof that the fetched commit is the recorded one; build it when a review is actually lost to retention |

## Not verified

- That a `pr` grant without refs is refused every write (`refAllowed` was not read).
- Which heads the delivery prompt lists as "repair heads" and where they are stored.
- The exact JSON that `gh pr view --json reviews` returns for a review's commit and author on the installed `gh` version.
- The reported shape of `run.pullRequest` handling in `consume` was read through a facts scout, not line by line.
