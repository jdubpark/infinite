import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type express from "express";
import { sessionListReader } from "../packages/remote/src/session-list.js";
import { sendSessionList } from "../packages/host/src/session-list.js";
import { claimControl, inProcessHost, waitFor } from "./helpers.js";

type Row = { id: string; status: string; attention?: { state: string } };

test("GET /api/sessions answers a client that names the version it holds", { timeout: 60_000 }, async () => {
  const host = await inProcessHost();
  try {
    const id = randomUUID();
    const created = await host.fetchApi("/sessions", "owner", { requestId: id, provider: "demo", projectId: "rehearsal", title: "Listed", prompt: "yesno" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const list = async (query = "") => {
      const response = await fetch(`${host.origin}/api/sessions${query}`, { headers: { Authorization: `Bearer ${host.tokens.owner}` } });
      return { status: response.status, type: response.headers.get("content-type"), text: await response.text() };
    };
    const plain = await waitFor(async () => [await list(), await list()], ([a, b]) =>
      a.text === b.text && (JSON.parse(a.text).sessions as Row[]).some(row => row.id === id && row.status === "running" && row.attention?.state === "needs-you"), 20_000).then(([a]) => a);

    assert.equal(plain.type, "application/json; charset=utf-8");
    const rows = JSON.parse(plain.text).sessions as Row[];
    assert.equal(plain.text, JSON.stringify({ sessions: rows }), "the default body carries only the rows");

    const first = JSON.parse((await list("?since=")).text);
    assert.deepEqual(Object.keys(first), ["version", "sessions"]);
    assert.match(first.version, /^[A-Za-z0-9_-]{22}$/);
    assert.deepEqual(first.sessions, rows, "the versioned answer carries the same rows");

    const unchanged = await list(`?since=${first.version}`);
    assert.equal(unchanged.status, 200);
    assert.deepEqual(JSON.parse(unchanged.text), { version: first.version, unchanged: true });
    const other = JSON.parse((await list(`?since=${"A".repeat(22)}`)).text);
    assert.deepEqual(other, first, "a version that is not current answers the whole list");

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

test("a refused since is refused before the list is built", async () => {
  let built = 0;
  const list = async () => { built++; return [{ id: "a" }]; };
  const sent: unknown[] = [];
  const res = { json: (body: unknown) => sent.push(body), type: () => res, send: (body: unknown) => sent.push(body) };
  const read = (since: unknown) => sendSessionList({ query: { since } } as unknown as express.Request, res as unknown as express.Response, list);
  for (const since of ["A".repeat(129), "a.b", "a b", ["a", "b"]]) await assert.rejects(read(since), JSON.stringify(since));
  assert.equal(built, 0, "a refused since never builds the list");
  assert.deepEqual(sent, []);
  await read("");
  assert.equal(built, 1, "an accepted since builds it once");
});

test("sendSessionList canonicalizes cmux row order without mutating caller arrays or reordering native rows", async () => {
  const nativeFirst = { id: "ffff-native", backend: "infinite", status: "running" };
  const nativeSecond = { id: "0000-native", backend: "infinite", status: "exited" };
  const cmuxA = { id: "00000000-0000-4000-8000-000000000000", backend: "cmux", status: "running" };
  const cmuxB = { id: "88888888-8888-4888-8888-888888888888", backend: "cmux", status: "exited" };
  const cmuxC = { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", backend: "cmux", status: "running" };

  const invoke = async (since: string | undefined, rows: unknown[]) => {
    let payload: unknown;
    let raw: string | undefined;
    const res = { json: (body: unknown) => { payload = body; }, type: () => res, send: (body: string) => { raw = body; } };
    await sendSessionList({ query: since === undefined ? {} : { since } } as unknown as express.Request, res as unknown as express.Response, async () => rows);
    return (payload ?? JSON.parse(raw!)) as { version?: string; unchanged?: true; sessions?: { id: string }[] };
  };

  const firstInput = [nativeFirst, nativeSecond, cmuxC, cmuxA, cmuxB];
  const secondInput = [nativeFirst, nativeSecond, cmuxB, cmuxC, cmuxA];
  const expectedOrder = [nativeFirst, nativeSecond, cmuxA, cmuxB, cmuxC];

  const plain = await invoke(undefined, firstInput);
  assert.deepEqual(plain.sessions, expectedOrder);
  assert.deepEqual(firstInput.map(row => row.id), [nativeFirst.id, nativeSecond.id, cmuxC.id, cmuxA.id, cmuxB.id]);

  const versionedA = await invoke("", firstInput);
  const versionedB = await invoke("", secondInput);
  assert.equal(versionedA.version, versionedB.version);
  assert.deepEqual(versionedA.sessions, expectedOrder);
  assert.deepEqual(versionedB.sessions, expectedOrder);
  assert.deepEqual(secondInput.map(row => row.id), [nativeFirst.id, nativeSecond.id, cmuxB.id, cmuxC.id, cmuxA.id]);

  const unchanged = await invoke(versionedA.version, secondInput);
  assert.deepEqual(unchanged, { version: versionedA.version, unchanged: true });
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
    await waitFor(async () => {
      const read = await list("");
      if (!read.sessions?.some(row => row.id === id && row.status === "exited")) return undefined;
      await new Promise(resolve => setTimeout(resolve, 2000));
      return list(read.version);
    }, again => again?.unchanged === true, 20_000);

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
  answers.push({ version: "v0", unchanged: true }, { sessions: [{ id: "b" }] });
  assert.deepEqual(await read(get), [{ id: "b" }]);
  answers.push({ sessions: [{ id: "c" }] }, { unchanged: true }, { error: "Invalid request" });
  assert.deepEqual(await read(get), [{ id: "c" }]);
  await assert.rejects(read(get), /cannot read/);
  assert.deepEqual(asked, ["/sessions?since=", "/sessions?since=v1", "/sessions?since=v1", "/sessions", "/sessions?since=", "/sessions?since=", "/sessions"]);
});

test("the client reader keeps the newer rows when two overlapping reads answer out of order", async () => {
  const read = sessionListReader<{ id: string }>(), asked: string[] = [], answer: ((body: unknown) => void)[] = [];
  const get = (path: string) => { asked.push(path); return new Promise<unknown>(resolve => answer.push(resolve)); };
  const older = read(get), newer = read(get);
  answer[1]!({ version: "v2", sessions: [{ id: "new" }] });
  assert.deepEqual(await newer, [{ id: "new" }]);
  answer[0]!({ version: "v1", sessions: [{ id: "old" }] });
  assert.deepEqual(await older, [{ id: "new" }], "the late answer to the earlier read resolves to the rows held");
  const next = read(get);
  answer[2]!({ version: "v2", unchanged: true });
  assert.deepEqual(await next, [{ id: "new" }]);
  assert.deepEqual(asked, ["/sessions?since=", "/sessions?since=", "/sessions?since=v2"], "the next read names the newer version");
});

test("an unchanged answer stands only for the version held when it arrives", async () => {
  const read = sessionListReader<{ id: string }>(), asked: string[] = [], answer: ((body: unknown) => void)[] = [];
  const get = (path: string) => { asked.push(path); return new Promise<unknown>(resolve => answer.push(resolve)); };
  const first = read(get);
  answer[0]!({ version: "v1", sessions: [{ id: "one" }] });
  await first;
  const a = read(get), b = read(get);
  answer[1]!({ version: "v2", sessions: [{ id: "two" }] });
  assert.deepEqual(await a, [{ id: "two" }]);
  answer[2]!({ version: "v1", unchanged: true });
  await new Promise(resolve => setImmediate(resolve));
  answer[3]?.({ sessions: [{ id: "two" }] });
  assert.deepEqual(await b, [{ id: "two" }], "v1's rows never come back once v2's are held");
  assert.deepEqual(asked, ["/sessions?since=", "/sessions?since=v1", "/sessions?since=v1", "/sessions"], "a stale unchanged is followed by a full read");
});
