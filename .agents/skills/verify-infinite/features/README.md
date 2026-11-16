# Verify Infinite: feature map

One file per user-facing feature of the web client in `apps/web/src`. Each file gives the sub-features, the user path to reach the feature, how to drive it with Playwright, and the gotchas that came up when the source was read. Read the feature file before driving it, and read `../SKILL.md` for launch, doctor, evidence, and cleanup.

| Feature | File | Scripted | Source |
| --- | --- | --- | --- |
| Sign in with a device key, and see the session list | [sign-in.md](sign-in.md) | Yes: `drive.mjs sign-in` (run end to end) | `apps/web/src/main.tsx` |
| Sessions: list, filters, search, new session | [sessions.md](sessions.md) | No, mapped to source | `apps/web/src/session-navigation.tsx`, `apps/web/src/main.tsx` |
| Session view: steering, control, tabs, lifecycle | [session-steering.md](session-steering.md) | No, mapped to source | `apps/web/src/main.tsx`, `apps/web/src/session-extras.tsx` |
| Teams: start a run, follow it, answer decisions | [teams.md](teams.md) | No, mapped to source | `apps/web/src/teams.tsx` |
| Goals: set an outcome and limits, steer, record the outcome | [goals.md](goals.md) | No, mapped to source | `apps/web/src/goals.tsx` |

"Scripted" means `scripts/drive.mjs` runs the journey and writes evidence. "Mapped to source" means the selectors and labels were read from the listed files. Those journeys have not been driven on a host yet, so a run that depends on one must say so in its report.

On the default development host (the rehearsal config), teams and goals are disabled. `GET /api/me` reports `teams.enabled: false` and `goals.enabled: false`. The Teams and Goals pages show setup notices until a host operator enables them. Their feature files say what to check.

Each feature file starts with what the feature is and the observable end state that proves it works. Then it has the four sections below.

- Sub-features
- How to get to it (user POV)
- Driving it with Playwright
- Gotchas
