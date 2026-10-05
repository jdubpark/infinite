import test from "node:test";
import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Session, Event } from "../packages/host/src/types.js";
import { demoProfile, startHost, waitFor } from "./helpers.js";

test(
  "13 real PTYs survive API death; reconnect and retries keep identity and deliver one input",
  { timeout: 60000 },
  async () => {
    const host = await startHost({
      agents: {
        codex: {
          command: process.execPath,
          // `--` keeps any hook flags the worker appends for Codex (off by default) out of node's own option parsing.
          args: [
            "-e",
            `
            process.stdin.setRawMode(true);
            let received = '';
            process.stdin.on('data', chunk => {
              received += chunk;
              if (received.includes('\\x1b[1;1R')) {
                for (let i = 0; i < 100; i++) console.log('row-' + String(i).padStart(3, '0'));
                console.log('terminal-query-ok');
                received = '';
              }
            });
            process.stdout.write('\\x1b[6n');
          `,
            "--",
          ],
        },
        demo: demoProfile(),
      },
    });
    const { origin, tokens, config, fetchApi } = host;
    const created: Session[] = [];
    try {
      const capabilities = (await fetchApi("/me")).body;
      assert.equal(capabilities.security.tenancy, "single-tenant");
      assert.equal(capabilities.security.isolation, "none-required");
      assert.equal(
        (await fetchApi("/sessions", null)).status,
        401,
        "unauthenticated clients cannot read logs",
      );
      assert.equal(
        (
          await fetchApi("/sessions", "owner", undefined, {
            Origin: "https://evil.example",
          })
        ).status,
        403,
      );
      const rebound = await new Promise<number | undefined>(
        (resolve, reject) => {
          httpGet(
            origin + "/api/sessions",
            {
              headers: {
                Host: "evil.example",
                Authorization: `Bearer ${tokens.owner}`,
              },
            },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          ).on("error", reject);
        },
      );
      assert.equal(rebound, 403);
      const login = await fetchApi(
        "/login",
        null,
        { token: tokens.owner },
        { Origin: origin },
      );
      assert.equal(login.status, 200);
      assert.match(login.headers.get("set-cookie")!, /HttpOnly/);
      assert.match(login.headers.get("set-cookie")!, /SameSite=Strict/);
      const initial = {
        requestId: randomUUID(),
        provider: "demo",
        projectId: "rehearsal",
        title: "Private continuity test",
        prompt: "initial-confidential-marker",
      };
      assert.equal(
        (await fetchApi("/sessions", "controller", initial)).status,
        403,
        "phone cannot create sessions",
      );
      const context = await fetchApi(
        "/projects/rehearsal/context",
        "owner",
        { text: "shared-confidential-marker", expectedVersion: 0 },
        {},
        "PUT",
      );
      assert.equal(context.body.version, 1);
      assert.equal(
        (
          await fetchApi(
            "/projects/rehearsal/context",
            "owner",
            { text: "stale overwrite", expectedVersion: 0 },
            {},
            "PUT",
          )
        ).status,
        409,
      );
      for (let i = 0; i < 12; i++) {
        const request =
          i === 0
            ? initial
            : { ...initial, requestId: randomUUID(), title: `Worker ${i}` };
        const response = await fetchApi("/sessions", "owner", request);
        assert.equal(response.status, 201);
        created.push(response.body);
        assert.equal(
          response.body.status,
          "running",
          JSON.stringify(response.body),
        );
      }
      assert.equal(new Set(created.map((s) => s.pid)).size, 12);
      const first = created[0];
      assert.equal(first.contextVersion, 1);
      assert.equal(first.context, "shared-confidential-marker");
      const repeated = await fetchApi("/sessions", "owner", initial);
      assert.equal(repeated.body.id, first.id);
      assert.equal(repeated.body.pid, first.pid);
      const message = {
        requestId: randomUUID(),
        text: "followup-confidential-marker",
        submit: true,
      };
      assert.equal(
        (await fetchApi(`/sessions/${first.id}/input`, "viewer", message))
          .status,
        403,
      );
      assert.equal(
        (
          await fetchApi(`/sessions/${first.id}/input`, "controller", {
            ...message,
            text: "\x1b[201~inject",
          })
        ).status,
        400,
      );
      const [a, b] = await Promise.all([
        fetchApi(`/sessions/${first.id}/input`, "controller", message),
        fetchApi(`/sessions/${first.id}/input`, "controller", message),
      ]);
      assert.equal(a.body.state, "delivered");
      assert.deepEqual(a.body, b.body);
      assert.equal(
        (
          await fetchApi(`/sessions/${first.id}/input`, "controller", {
            ...message,
            text: "different",
          })
        ).status,
        409,
      );
      const before = await waitFor(
        async () => (await fetchApi(`/sessions/${first.id}`)).body,
        (value) => value.screen.includes("You: followup-confidential-marker"),
      );
      assert.equal(
        before.screen.split("You: followup-confidential-marker").length - 1,
        1,
      );
      // A session holding an open dialog must keep its attention across the API restart.
      const dialog = await fetchApi("/sessions", "owner", {
        requestId: randomUUID(),
        provider: "demo",
        projectId: "rehearsal",
        title: "Dialog attention",
        prompt: "dialog",
      });
      assert.equal(dialog.status, 201);
      created.push(dialog.body);
      const dialogBefore = (
        await waitFor(
          async () => (await fetchApi(`/sessions/${dialog.body.id}`)).body,
          (value) =>
            value.attention?.state === "needs-you" &&
            value.attention.prompt?.hash,
          15000,
        )
      );
      const signalOpens = async () =>
        (
          (await fetchApi(
            `/sessions/${dialog.body.id}/events?types=lifecycle,signal`,
          )).body.events as Event[]
        ).filter(
          (event) => event.type === "signal" && event.data.kind === "prompt-open",
        );
      const opensBefore = await signalOpens();
      assert.equal(opensBefore.length, 1);
      assert.equal(dialogBefore.attention.prompt.id, opensBefore[0].seq);
      await host.stopApi();
      // No API process or connected client exists while these PTYs make progress.
      await new Promise((resolve) => setTimeout(resolve, 3200));
      await host.start();
      const dialogAfter = (await fetchApi(`/sessions/${dialog.body.id}`)).body;
      assert.equal(dialogAfter.attention.state, "needs-you");
      assert.equal(dialogAfter.attention.prompt.options.length, 3);
      assert.equal(dialogAfter.attention.prompt.id, opensBefore[0].seq);
      assert.equal(dialogAfter.pid, dialog.body.pid);
      assert.deepEqual(
        (await signalOpens()).map((event) => event.seq),
        opensBefore.map((event) => event.seq),
      );
      const after = (await fetchApi(`/sessions/${first.id}`)).body;
      assert.equal(after.pid, first.pid);
      assert.equal(after.status, "running");
      assert.ok(after.seq > before.seq);
      assert.equal((await fetchApi("/sessions")).body.sessions.length, 13);
      const retryAfterRestart = await fetchApi(
        `/sessions/${first.id}/input`,
        "controller",
        message,
      );
      assert.deepEqual(retryAfterRestart.body, a.body);
      const recording: Event[] = [];
      let cursor = 0;
      do {
        const page = (
          await fetchApi(`/sessions/${first.id}/events?after=${cursor}&limit=2`)
        ).body;
        recording.push(...page.events);
        cursor = page.cursor;
        if (!page.more) break;
      } while (true);
      assert.deepEqual(
        recording.map((event) => event.seq),
        Array.from({ length: recording.length }, (_, i) => i + 1),
      );
      assert.equal(
        recording.filter(
          (event) =>
            event.type === "input-intent" &&
            event.data.requestId === message.requestId,
        ).length,
        1,
      );
      assert.equal(
        recording.filter(
          (event) =>
            event.type === "input-result" &&
            event.data.requestId === message.requestId,
        ).length,
        1,
      );
      for (const session of created) {
        const directory = join(config.stateDir, "sessions", session.id);
        for (const name of readdirSync(directory, { recursive: true })
          .map(String)
          .filter((n) => n.endsWith(".sealed") || n.endsWith(".journal"))) {
          const raw = readFileSync(join(directory, name), "utf8");
          for (const marker of [
            "initial-confidential-marker",
            "shared-confidential-marker",
            "followup-confidential-marker",
          ])
            assert.equal(raw.includes(marker), false);
        }
      }
      const stop = await fetchApi(`/sessions/${first.id}/stop`, "owner", {
        requestId: randomUUID(),
      });
      assert.equal(stop.status, 200);
      await waitFor(
        async () => (await fetchApi(`/sessions/${first.id}`)).body.status,
        (value) => value === "exited",
      );
      assert.ok(
        (await fetchApi(`/sessions/${first.id}/events`)).body.events.length > 0,
        "recording remains readable after exit",
      );
      const terminalSession = await fetchApi("/sessions", "owner", {
        ...initial,
        requestId: randomUUID(),
        provider: "codex",
        prompt: "",
        title: "Terminal protocol fixture",
      });
      assert.equal(terminalSession.status, 201);
      created.push(terminalSession.body);
      const terminalView = await waitFor(
        async () =>
          (await fetchApi(`/sessions/${terminalSession.body.id}`)).body,
        (value) => value.screen.includes("terminal-query-ok"),
        3000,
      );
      assert.ok(terminalView.screen.includes("row-099"));
      assert.ok(
        !terminalView.screen.includes("row-000"),
        "compact screen omits old scrollback",
      );
      // Screen parsing can finish before the worker's buffered journal flush.
      const terminalOutput = await waitFor(
        async () => {
          const events = (
            await fetchApi(`/sessions/${terminalSession.body.id}/events`)
          ).body.events as Event[];
          return events
            .filter((event) => event.type === "output")
            .map((event) => String(event.data.text))
            .join("");
        },
        (output) => output.includes("terminal-query-ok"),
        3000,
      );
      assert.ok(
        terminalOutput.includes("row-000"),
        "full recording retains old output",
      );
    } finally {
      await host.stop();
    }
  },
);
