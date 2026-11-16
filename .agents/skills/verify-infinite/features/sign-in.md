# Sign in with a device key

The web client asks for a device key before it shows anything. A valid key sets a browser session cookie and opens the workspace: the machine picker, the workspace views (Swarm, Sessions, Teams, Goals), and the session rail. The observable end state is the rail heading `Sessions N`, where N equals the number of sessions in `GET /api/sessions`, and the browser holds the `infinite` cookie. The scripted journey `drive.mjs sign-in` checks both.

## Sub-features

- Login page: heading "Pick up where you left off.", the device key field `#device-key` (label "Device key"), and the submit button "Connect to Infinite" (the form's `button.primary`).
- Key roles: the owner key creates sessions, teams, and goals. A controller key steers and answers decisions. A viewer key reads. The login note reads "Use your laptop's owner key or a limited device key."
- Refusal: an unknown key shows the alert "Device key was not recognized". Ten attempts per minute from one client address are allowed; the eleventh gets "Too many attempts. Try again in one minute."
- Machine picker: a select above the workspace, showing the host's label (the verification host shows its `--name` value).
- Session cookie: `infinite`, httpOnly, SameSite Strict, twelve hours, scoped to `/api`.
- Sign out: "Disconnect this device" at the foot of the rail calls `POST /api/logout`.

## How to get to it (user POV)

Open the host origin in a browser. With no session cookie, the login page is the first screen. The user pastes a device key and selects "Connect to Infinite". On success the Sessions workspace opens with the session rail, and the Active filter is selected by default.

## Driving it with Playwright

Use the origin exactly as the host was configured. Browser sign-in is refused unless the request's Origin matches, so `localhost` fails while `127.0.0.1` works. The key is read from the instance's `devices.json` and is never printed.

```js
await page.goto(origin);
await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
await page.locator("#device-key").fill(ownerKey);
await page.locator("form:has(#device-key) button.primary").click();
await expect(page.getByRole("navigation", { name: "Sessions", exact: true })).toBeVisible();
const cookies = await context.cookies(`${origin}/api/me`); // the cookie is scoped to /api
```

The journey in `scripts/drive.mjs` (`sign-in`) runs these steps, plus the refusal check first, and writes `sign-in.json` with the verdict. Its end-state checks are the rail count against `GET /api/sessions`, the cookie flags, and the absence of the owner key from the page HTML. Its screenshots are `01-sign-in.png` (login) and `02-session-list.png` (All view, empty on a fresh host).

## Gotchas

- Cookie lookup: `context.cookies(origin)` returns nothing for this session cookie, because it is scoped to `/api`. Ask for `${origin}/api/me`. The first run of the journey made this mistake.
- Origin: the host builds its origin from `--port` at initialization (`http://127.0.0.1:PORT`). A mismatched origin returns 403 "Browser sign-in requires the configured origin".
- Rate limit: the refusal check uses one attempt. Repeated failed runs within a minute get 429 from the same address. Wait a minute or restart the host.
- A fresh host has no sessions, so the All view shows the empty state "Create a session on this machine to see it here." That is a valid end state, but the list-to-API comparison is weak on an empty host. Start a session first when the count matters.
- The owner key must not appear in evidence. The journey checks the page; `SKILL.md` describes the check for files.
