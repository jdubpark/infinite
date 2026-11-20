import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sessionListReader } from "../packages/remote/src/session-list.js";
import { claimControl, inProcessHost, waitFor } from "./helpers.js";

type Row = { id: string; status: string };

test("GET /api/sessions answers a client that names the version it holds", { timeout: 60_000 }, async () => {
  const host = await inProcessHost();
  try {
    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Listed", prompt: "Wait here" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const list = async (query = "") => {
      const response = await fetch(`${host.origin}/api/sessions${query}`, { headers: { Authorization: `Bearer ${host.tokens.owner}` } });
      return { status: response.status, type: response.headers.get("content-type"), text: await response.text() };
    };
    // A running session holds still between reads once it has started, so two reads of it are the same list.
    const plain = await waitFor(async () => [await list(), await list()], ([a, b]) =>
      a.text === b.text && (JSON.parse(a.text).sessions as Row[]).some(row => row.id === id && row.status === "running"), 20_000).then(([a]) => a);

    // An installed client asks without a version and reads the body it always read.
    assert.equal(plain.type, "application/json; charset=utf-8");
    const rows = JSON.parse(plain.text).sessions as Row[];
    assert.equal(plain.text, JSON.stringify({ sessions: rows }), "the default body carries only the rows");

    // A client that holds no version asks with an empty one and receives the rows with their version.
    const first = JSON.parse((await list("?since=")).text);
    assert.deepEqual(Object.keys(first), ["version", "sessions"]);
    assert.match(first.version, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(first.sessions, rows, "the versioned answer carries the same rows");

    const unchanged = await list(`?since=${first.version}`);
    assert.equal(unchanged.status, 200);
    assert.deepEqual(JSON.parse(unchanged.text), { version: first.version, unchanged: true });
    const other = JSON.parse((await list(`?since=${"A".repeat(22)}`)).text);
    assert.deepEqual(other, first, "a version that is not current answers the whole list");

    // The web and phone reader against this host: the second poll names the version and keeps the rows it read.
    const read = sessionListReader<Row>(), asked: string[] = [];
    const get = async (path: string) => { asked.push(path); return (await host.fetchApi(path)).body; };
    const held = await read(get);
    assert.deepEqual(held, rows);
    assert.equal(await read(get), held, "an unchanged list keeps the rows already read");
    assert.deepEqual(asked, ["/sessions?since=", `/sessions?since=${first.version}`]);

    const control = await claimControl(host, id, "owner");
    assert.equal((await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() }, control.headers)).status, 200);
    const changed = await waitFor(async () => JSON.parse((await list(`?since=${first.version}`)).text),
      body => (body.sessions as Row[] | undefined)?.find(row => row.id === id)?.status === "exited", 20_000);
    assert.notEqual(changed.version, first.version, "a changed row names a new version");
    assert.match(changed.version, /^[A-Za-z0-9_-]{22}$/);

    for (const query of [`?since=${"A".repeat(129)}`, "?since=a.b", "?since=a%20b", "?since=a&since=b"]) {
      const refused = await list(query);
      assert.equal(refused.status, 400, query);
      assert.equal(JSON.parse(refused.text).error, "Invalid request", query);
    }
  } finally { await host.stop(); }
});

test("an exited session reads the same on every poll, and the live list sends it once", { timeout: 60_000 }, async () => {
  const host = await inProcessHost();
  try {
    const id = randomUUID();
    assert.equal((await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Ended", prompt: "Stop soon" })).status, 201);
    const control = await claimControl(host, id, "owner");
    assert.equal((await host.fetchApi(`/sessions/${id}/stop`, "owner", { requestId: randomUUID() }, control.headers)).status, 200);
    type Answer = { version: string; unchanged?: true; sessions?: Row[] };
    const list = async (since: string) => (await host.fetchApi(`/sessions?since=${since}`)).body as Answer;
    // The row changes once more when its worker leaves, 1.5 s after the provider exits, and the saved status answers
    // for it. After that, a poll two seconds later names the same version: the row carries recorded times, not the
    // time of the read.
    await waitFor(async () => {
      const read = await list("");
      if (!read.sessions?.some(row => row.id === id && row.status === "exited")) return undefined;
      await new Promise(resolve => setTimeout(resolve, 2000));
      return list(read.version);
    }, again => again?.unchanged === true, 20_000);

    // The live list compares each 750 ms snapshot with the last one sent, so an unchanged list is sent once.
    const response = await fetch(`${host.origin}/api/events?topics=sessions`, { headers: { Authorization: `Bearer ${host.tokens.owner}` }, signal: AbortSignal.timeout(3000) });
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let text = "";
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value, { stream: true }); } }
    catch (error) { if ((error as Error).name !== "TimeoutError") throw error; }
    assert.equal(text.match(/event: update/g)?.length, 1, "four ticks of an unchanged list send one update");
  } finally { await host.stop(); }
});

test("the client reader reads a host that ignores since, and follows an answer it cannot read with a plain read", async () => {
  const read = sessionListReader<{ id: string }>(), asked: string[] = [], answers: unknown[] = [];
  const get = async (path: string) => { asked.push(path); return answers.shift(); };
  answers.push({ version: "v1", sessions: [{ id: "a" }] }, { version: "v1", unchanged: true });
  assert.deepEqual(await read(get), [{ id: "a" }]);
  assert.deepEqual(await read(get), [{ id: "a" }]);
  // An unchanged answer that names another version cannot stand for the rows held.
  answers.push({ version: "v0", unchanged: true }, { sessions: [{ id: "b" }] });
  assert.deepEqual(await read(get), [{ id: "b" }]);
  // A host that predates `since` answers rows alone, so the next read asks for a version again.
  answers.push({ sessions: [{ id: "c" }] }, { unchanged: true }, { error: "Invalid request" });
  assert.deepEqual(await read(get), [{ id: "c" }]);
  await assert.rejects(read(get), /cannot read/);
  assert.deepEqual(asked, ["/sessions?since=", "/sessions?since=v1", "/sessions?since=v1", "/sessions", "/sessions?since=", "/sessions?since=", "/sessions"]);
});
