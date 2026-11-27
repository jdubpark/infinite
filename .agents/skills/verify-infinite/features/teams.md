# Teams: start a run, follow it, and answer decisions

A team takes a feature request or PRD and runs a project manager, implementers, integration, the configured checks, and an independent review, on isolated working copies of the selected workspace. Questions and steering stay with the run. The observable end state for a started run is a new entry in `GET /api/teams` with the objective you typed, and a team page that shows its agents and status. On the development host teams are disabled, so the page shows "Teams need host setup." and the form must not be submitted.

## Sub-features

- Teams list (workspace view "Teams"): heading "Give your team an outcome.", the owner's "New team" button, and one row per run (`.team-run-row`). Blocked runs are listed first.
- Setup notices (`SetupNotice` in `apps/web/src/teams.tsx`):
  - "Teams need host setup." when the host has not enabled teams (`GET /api/me` → `teams.enabled` is false).
  - "No workspace is ready for a team." when no workspace has required checks.
  - "This workspace needs required team checks in the host configuration." on the form when teams are on but the chosen workspace has no checks.
- New team form, headed by a "Feature request or PRD" field:
  - `#team-objective`: required, eight rows.
  - `#team-title`: "Team name (optional)", 100 characters.
  - `#team-project`: "Workspace".
  - `#team-agent-setup`: "Agent setup", shown only when the host has a configured lineup. Its value is "configured" or "single".
  - `#team-provider`: "Agent provider", shown in single-agent mode.
  - Submit: "Start team" (becomes "Retry same request" after an unconfirmed delivery).
  - A form note warns when the workspace tracks team work in Linear: starting the team creates an issue.
- Team view: aria-labels "Team view" and "Agents", the decision list with "Send answer" (each decision has a "Your answer" field), steering with "Send direction" (`#team-direction`, "Steer this team"), and "Continue development" (`#team-direction` relabelled "Direction for continuation") for runs that finished and can continue.
- Permissions: owners start, continue, and cancel runs. Controllers answer decisions and steer. Viewers see "This device can view the team."

## How to get to it (user POV)

Open the Teams workspace view from the rail, then select "New team" (owner). Fill in the objective, pick the workspace, and select "Start team". The page then shows "Team started." with "Open team". The run appears in the Teams list with what it is waiting on. Select a run to follow it, answer its decisions, or send direction.

## Driving it with Playwright

Sign in first (see [sign-in.md](sign-in.md)). This is the path to check on a host with teams enabled. On the development host, stop after the setup notice.

```js
await page.getByRole("button", { name: "Teams", exact: true }).click();
await expect(page.getByRole("heading", { name: "Give your team an outcome." })).toBeVisible();
// Development host: expect the setup notice and do not submit.
await expect(page.getByRole("status").filter({ hasText: "Teams need host setup." })).toBeVisible();
// Host with teams enabled and a workspace with checks:
await page.getByRole("button", { name: "New team", exact: true }).click();
await page.locator("#team-objective").fill("Add a health endpoint that returns the build version.");
await page.locator("#team-provider").selectOption("demo"); // only when the single-agent select offers Rehearsal
await page.getByRole("button", { name: "Start team", exact: true }).click();
```

End-state checks on a host with teams enabled: the page shows "Team started.", `GET /api/teams` lists a run with the same objective, and the run page shows no error notice after its first update. Rehearsal (`demo`) runs a local test process. The form says it "does not call an AI model or implement a real feature", so use it only to check the workflow, never as evidence that code was written.

## Gotchas

- The development host has teams disabled. Enabling them needs host configuration (`teams.workspaceDir`, and required checks on each workspace). See the "Start from a terminal" section of `docs/teams.md`. The `team` journey enables teams only in its own disposable instance (`configure --profile teams` in SKILL.md, Teams and goals host); it never changes the host it is given. Report any gap in a host you did not create.
- A started team creates isolated working copies and runs the configured checks. With a real provider lineup it uses the provider accounts and permissions configured on the host.
- The form is disabled for non-owners ("An owner key is required to start a team.").
- If the request is not confirmed, the page shows "Delivery is unconfirmed. Retry keeps the same creation request." Use the retry button rather than starting a second run.
- Do not treat a team's "Delivery" or review status as proof that a feature works. Read the recorded evidence on the run.
