# Sessions: list, filters, search, and new session

The Sessions workspace lists the agent sessions on the selected machine. Filters and search narrow the list, and the "+" button starts a session. On the development host the demo provider appears as **Rehearsal**. The observable end state for a new session is a row in the list with status `running` and provider Rehearsal, and `GET /api/sessions` returns one session with `provider: "demo"` and the same title.

## Sub-features

- Rail heading "Sessions N": N counts every session on the machine.
- Filter group "Filter sessions" with three buttons, each showing its count: Active (status `running` or `starting`, the default), Needs you (attention state `needs-you`), and All.
- Search "Find a session" (`input`, aria-label "Find a session"). It matches the title, the session ID, the workspace ID, the provider key, and the provider name. Escape clears it, and the clear button has the label "Clear session search".
- Rows: a `nav` labelled "Sessions" holds one button per session showing the title, the provider name, the status ("Needs you", "Turn finished", or the process status), any usage-limit notice, and the first eight characters of the ID. The selected row has `aria-current="page"`.
- Empty states: "No active sessions.", "No sessions need your attention.", "No matching sessions in this view." (with "Show all sessions"), and "Create a session on this machine to see it here." when All is empty.
- New session (owner only): the "+" icon button with aria-label "New session" in the rail heading opens the page headed "Start something." It has these fields: "Session host" (`#backend`, Infinite or cmux when enabled), "Agent" (`#provider`, options from the host's configured providers, with demo labelled "Rehearsal"), "Workspace" (`#project`), "Session name" (`#title`, required, 100 characters), and "First request (optional)" (`#prompt`, 24000 characters). The submit button is "Start session".

## How to get to it (user POV)

Sign in (see [sign-in.md](sign-in.md)). The Sessions item in the workspace views is selected by default. To start a session, select the "+" beside "Sessions" in the rail. The form appears. Choose the agent, type a name, and select "Start session". The page then shows "Session created." with "Open created session". The new row appears under Active.

## Driving it with Playwright

Sign in first. The selectors below are the ones the source uses; verify them against the running page the first time.

```js
await page.getByRole("button", { name: "Sessions", exact: true }).click();
await page.getByRole("button", { name: "New session", exact: true }).click();
await page.locator("#provider").selectOption("demo"); // shown as "Rehearsal"
await page.locator("#title").fill("Verification session");
await page.locator("#prompt").fill("Reply with one line.");
await page.getByRole("button", { name: "Start session", exact: true }).click();
await expect(page.getByRole("navigation", { name: "Sessions", exact: true })
  .getByRole("button", { name: /Verification session/ })).toBeVisible({ timeout: 15000 });
```

End-state checks: the row's text includes "Rehearsal" and "running", the Active count is 1, and `GET /api/sessions` (owner bearer) returns that session with `provider: "demo"`, `status: "running"`, and a `pid`. Stop the session before cleanup: open its row and select "End session". The confirmation dialog must be accepted, or the action does nothing. See [session-steering.md](session-steering.md).

## Gotchas

- Owner only: "New session" is shown only to the owner. A controller or viewer sees the form disabled with "An owner key is required to create sessions."
- Providers are host configuration. The development host lists claude, codex, grok, and opencode as well as the demo. Those launch real CLIs that may wait for authentication, workspace trust, or a permission prompt. A verification run should select only "Rehearsal".
- The Start button stays disabled until the browser is connected to the host, the session name is non-empty, and a workspace is selected.
- A started session is a detached worker. It keeps running after the browser or API closes. End it before cleanup. Cleanup stops it through the API anyway, but ending it in the UI is the user path.
- New sessions show under Active and All, not under "Needs you", unless their attention state is `needs-you`.
- The First request is optional. Rehearsal does not call a model. For each line of input it prints `You: <line>` and `Rehearsal: message received by process <pid>.` (`packages/host/src/demo.ts`), which is what the steering checks look for.
