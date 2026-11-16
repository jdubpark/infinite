# Session view: steering, control, tabs, and lifecycle

Selecting a session opens its view: a header with the title, provider, and status; five tabs (Chat, Catch up, Terminal, Files, Context); a control bar; and a composer for sending a message to the agent. The observable end state for a steering message is the agent's reply on the screen, for example `You: <message>` followed by `Rehearsal: message received by process <pid>.` on the Rehearsal provider. Delivery to the terminal is a separate receipt in "Session activity"; it is not proof that the agent acted on the message.

## Sub-features

- Header: the provider name and status, "Tools run on <machine>", and "PID n" or "No live process". The "Export decrypted log" icon button has that aria-label.
- Tabs, role `tab` in the tablist "Session views":
  - Chat: the conversation.
  - Catch up: a `pre` labelled "Current terminal screen" with "Follow latest" and "Following latest" toggles, and the "Session activity" list ("Input requested", "Input delivered to terminal", "Input delivery uncertain", and signal or status events).
  - Terminal: a read-only xterm replay (`.xterm-screen`) with the recording.
  - Files: project files for the session's workspace.
  - Context: the context the session started with.
- Composer: textarea `#message` labelled "Message to agent". Its placeholder is "Give this session a direction…" when steering is allowed, and "Draft here. Take control when you are ready to send…" otherwise. The send button has aria-label "Send message", changing to "Sending message" while busy and "Retry same message" after an unconfirmed delivery. Cmd/Ctrl+Enter sends; Enter adds a line.
- Control bar: a state label, which is "You have control", "Monitoring", "View only", or "Shared controls". Its action is "Take control", or "Take over" when another device holds the lease, and "Stop controlling" once held. The refresh button has aria-label "Refresh this session".
- Lifecycle (owner only): "End session" asks "End this session? This stops the agent process and keeps its recording…" in a browser confirmation dialog. "Resume session" appears for ended sessions that have a saved provider conversation.
- Attention: when the agent asks for a decision, a panel labelled "Session needs your decision" shows the prompt, with a "Reply instead…" field.
- Footer: "Unsent draft · kept in this tab" while typing, and "Unconfirmed delivery · retry keeps the same request ID" after a failed send.

## How to get to it (user POV)

From the Sessions workspace, select a row in the session rail. The view opens on the Chat tab. Use the tabs for the screen, the terminal, the files, and the context. Type in the composer, take control when the control bar asks, and select "Send message".

## Driving it with Playwright

Scripted: `drive.mjs session` runs the owner steering path below, the offline reconnect with the same PID, the Terminal and Context tabs, and the controller's phone view of the same transcript. It writes `session.json` and screenshots to the evidence directory. Start from a signed-in page with a running Rehearsal session (see [sessions.md](sessions.md)) if you drive it by hand.

```js
await page.getByRole("navigation", { name: "Sessions", exact: true })
  .getByRole("button", { name: /Verification session/ }).click();
await page.getByRole("tab", { name: "Catch up", exact: true }).click();
const take = page.getByRole("button", { name: /^Take (control|over)$/ });
if (await take.count()) await take.click(); // only when the control bar offers it
await page.locator("#message").fill("Verification message 1");
await page.getByRole("button", { name: "Send message", exact: true }).click();
await expect(page.locator("pre.screen")).toContainText("You: Verification message 1", { timeout: 10000 });
await expect(page.locator("pre.screen")).toContainText("message received by process");
```

End-state checks: the screen shows the `You:` line and the Rehearsal reply, the activity list shows "Input delivered to terminal", and `GET /api/sessions/:id` shows the same process ID as the header's PID. To end the session, accept the confirmation dialog before the click registers: `page.once("dialog", (dialog) => dialog.accept());` and then click "End session". The status then changes to exited.

Offline check, as the scripted run does it: fill `#message` with a draft, then `context.setOffline(true)`. Wait for the `.connection` span to read "Reconnecting" (the header also shows "Reconnecting · cached view" in the rail) and for "Send message" to be disabled. Then `context.setOffline(false)`, wait for "Up to date", and check that the header PID did not change. The browser context controls the offline state; API calls made from Node are not affected.

Phone check: a context with a 390x844 viewport, `isMobile: true`, and `hasTouch: true`, signed in with the controller key. Open the session from the rail, select "Catch up", and check that `pre.screen` shows the owner's `You:` line and that `document.documentElement.scrollWidth <= window.innerWidth`.

## Gotchas

- Control lease: after an offline gap the page drops its control (it shows "Monitoring" and "Take control") while the host keeps the lease for up to 30 seconds. During that time a stop or input from another actor gets HTTP 409. Take control again, and release it with "Stop controlling" when done.
- Steering needs a fresh connection and the control lease when the control bar says so. Send stays disabled while the view is stale, while control is held by someone else, and when there is no text.
- Viewer keys see "This device has view-only access." and no composer.
- Input control is per worker. When the session reports `capabilities.inputControl === 1`, the state reads "Monitoring" and the "Take control" button appears; Send stays disabled until the lease is taken. Otherwise the state reads "Shared controls" and Send works without a lease. Read the state label before deciding whether a click is needed.
- Delivery is not completion. "Input delivered to terminal" means the bytes reached the PTY. The host never infers that the agent finished or approved anything. Verify the agent's reply on the screen.
- When a prompt is open, Send is disabled on the Chat and Files tabs. Use the Catch up or Terminal tab to answer, or the "Reply instead…" field.
- Confirmation dialogs: "End session" and the goal's "Cancel goal" use `window.confirm`. Playwright does nothing with them unless a dialog handler accepts them.
- Ctrl/Cmd+Enter is the send shortcut. Plain Enter inserts a newline, so `fill()` followed by Enter does not send.
- Tabs use roving focus: Arrow keys move between tabs and focus them.
