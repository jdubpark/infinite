# Goals: outcome, limits, steering, and recorded results

A goal states a product outcome, its success criteria, the files the team may change, and hard limits on cycles, time, and agent members. Strong coordinators and reviewers run each cycle from the previous reviewed commit. The host never marks a goal achieved on its own; an owner records the outcome with evidence. The observable end state for a created goal is an entry in `GET /api/goals` whose objective and allowed paths match the form, with status and limits as entered. On the development host goals are disabled, so the page shows a setup notice and the form must not be submitted.

## Sub-features

- Goals list (workspace view "Goals"): heading "Set the outcome and the limits.", the owner's "New goal" button, and one row per goal (`.team-run-row`) with its workspace, cycles used out of the maximum, and deadline.
- Setup notices (`GoalSetup` in `apps/web/src/goals.tsx`):
  - "Goals need a configured team lineup." when goals are disabled or the host has no team lineup.
  - "No workspace is configured for goals." when no workspace has required checks.
- New goal form, eyebrow "New product goal", heading "What should improve?":
  - `#goal-objective` "Desired outcome": required, five rows.
  - `#goal-success` "Success criteria": required.
  - `#goal-title` "Goal name (optional)".
  - `#goal-project` "Workspace".
  - `#goal-linear-issue` "Existing Linear issue (optional)": only when the workspace has Linear enabled.
  - `#goal-paths` "Allowed files and folders": required. The team may change only files inside these paths.
  - `#goal-non-goals` "Non-goals (optional)" and `#goal-evidence` "Evidence and context (optional)".
  - Work limits, each a number input: `#goal-maxRuns` "Maximum cycles" (1 to 10), `#goal-maxMinutes` "Time limit (minutes)" (5 to 1440), `#goal-extendMinutes` "Extension when agents are active (minutes)" (0 to 240), `#goal-maxTotalMinutes` "Total time ceiling (minutes)" (at least the time limit, up to 1440), and `#goal-maxMembers` "Maximum agent members" (4 to 200).
  - Submit: "Start goal". It stays disabled until the objective, success criteria, and allowed paths are filled.
- Goal view: "Steer this goal" (`#goal-direction`) with "Send direction"; "Pause goal" or "Resume goal"; "Cancel goal" (confirmation dialog); "Extend time" (a `details` element with a minutes field); and "Record your assessment" (a `details` element with an outcome select `#goal-outcome-result`, `#goal-outcome-summary`, `#goal-outcome-evidence`, and "Record assessment"). The assessment records a person's judgment and does not publish changes.

## How to get to it (user POV)

Open the Goals workspace view, then select "New goal" (owner). Fill in the outcome, the success criteria, the workspace, and the allowed files and folders. Adjust the work limits if needed, then select "Start goal". Select a goal in the list to follow its cycles, steer it, pause or resume it, extend its time, or record its outcome.

## Driving it with Playwright

Sign in first (see [sign-in.md](sign-in.md)). On the development host, check the setup notice and stop.

```js
await page.getByRole("button", { name: "Goals", exact: true }).click();
await expect(page.getByRole("heading", { name: "Set the outcome and the limits." })).toBeVisible();
await expect(page.getByRole("status").filter({ hasText: "Goals need a configured team lineup." })).toBeVisible();
// Host with goals and a lineup enabled:
await page.getByRole("button", { name: "New goal", exact: true }).click();
await page.locator("#goal-objective").fill("Reduce the sign-in page's first paint time.");
await page.locator("#goal-success").fill("Measured first paint is below the recorded baseline.");
await page.locator("#goal-paths").fill("apps/web/src/main.tsx");
await page.getByRole("button", { name: "Start goal", exact: true }).click();
```

End-state checks on a host with goals enabled: `GET /api/goals` lists a goal whose objective, allowed paths, and limits match the form, and the goal page shows its status. Do not record an outcome during a verification run unless the task asks for one; it is a person's judgment and it is stored with the goal.

## Gotchas

- The development host has goals disabled (`GET /api/me` → `goals.enabled: false`) and no team lineup. Goals depend on the teams feature, so the same host setup applies. Report the gap rather than changing host configuration.
- Goal cycles run teams. Everything in [teams.md](teams.md) about isolated working copies, configured checks, and real providers applies to every cycle.
- Creation is owner only. Steering and recording an outcome are owner or controller actions. Pause, resume, cancel, extend, and parallelism are owner-only; the host answers a controller's request for them with 403.
- "Total time ceiling" must be at least the time limit. The form enforces this with `min`, so a smaller value is rejected by the browser before the request is sent.
- Cancelling a goal stops its active work and keeps its recorded cycles. Confirm the dialog in Playwright or the action does nothing.
- Linear, when enabled for the workspace, is only linked. Infinite does not mark issues Done automatically.
