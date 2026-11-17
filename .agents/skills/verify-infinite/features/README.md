# Verify Infinite: feature map

One file per user-facing feature of the web client in `apps/web/src`. Each file gives the sub-features, the user path to reach the feature, how to drive it with Playwright, and the gotchas that came up when the source was read. Read the feature file before driving it, and read `../SKILL.md` for launch, doctor, evidence, and cleanup.

| Feature | File | Scripted | Source |
| --- | --- | --- | --- |
| Sign in with a device key, and see the session list | [sign-in.md](sign-in.md) | Yes: `drive.mjs sign-in` (run end to end) | `apps/web/src/main.tsx` |
| Sessions: list, filters, search, new session | [sessions.md](sessions.md) | Yes: `drive.mjs session` (start, open, PID) | `apps/web/src/session-navigation.tsx`, `apps/web/src/main.tsx` |
| Session view: steering, control, tabs, lifecycle | [session-steering.md](session-steering.md) | Yes: `drive.mjs session` (steer, offline, tabs, phone) | `apps/web/src/main.tsx`, `apps/web/src/session-extras.tsx` |
| Teams: start a run, follow it, answer decisions | [teams.md](teams.md) | Yes: `drive.mjs team` (start a run, follow it to ready for review, check the API) | `apps/web/src/teams.tsx` |
| Goals: set an outcome and limits, steer, record the outcome | [goals.md](goals.md) | Yes: `drive.mjs goal` (create a one-cycle goal, follow it, check the API) | `apps/web/src/goals.tsx` |

"Scripted" means `scripts/drive.mjs` runs the journey and writes evidence. "Mapped to source" means the selectors and labels were read from the listed files. The sessions and steering journeys are one command, `drive.mjs session`, and have been run end to end on a disposable host. The team and goal journeys run on their own profile instances (SKILL.md, Teams and goals host) and use fixture agents, so they prove the web workflow and status reporting only. Teams and goals that are only mapped to source must say so in their report.

On the default development host (the rehearsal config), teams and goals are disabled. `GET /api/me` reports `teams.enabled: false` and `goals.enabled: false`. The Teams and Goals pages show setup notices until a host operator enables them. Their feature files say what to check.

Each feature file starts with what the feature is and the observable end state that proves it works. Then it has the four sections below.

- Sub-features
- How to get to it (user POV)
- Driving it with Playwright
- Gotchas
