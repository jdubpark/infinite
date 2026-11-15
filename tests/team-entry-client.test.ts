import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memberEntryId, memberEntryPostSchema } from "../packages/host/src/evidence/member-entry.js";
import { entryErrorMessage, submitEntryCall } from "../packages/host/src/team-entry-client.js";

const binding = { runId: randomUUID(), memberId: randomUUID(), revision: 2 };
const env = {
  INFINITE_HOOK_URL: "http://127.0.0.1:4321/hook",
  INFINITE_HOOK_TOKEN: "test-hook-token",
  INFINITE_TEAM_ASSIGNMENT: JSON.stringify(binding),
};
const contract = {
  kind: "contract",
  summary: "Settings shape",
  paths: ["src/settings"],
  body: { interface: "GET /settings", change: "adds theme" },
};

/** Replaces globalThis.fetch and records each call. */
function stubFetch(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("the client builds the envelope the worker expects", async () => {
  const stub = stubFetch(() => Response.json({ entry: { entryId: "x", state: "pending" } }));
  try {
    const reversed = {
      body: { change: "adds theme", interface: "GET /settings" },
      paths: ["src/settings"],
      summary: "Settings shape",
      kind: "contract",
    };
    const answer = await submitEntryCall({ op: "post", entry: contract }, env);
    await submitEntryCall({ op: "post", entry: reversed }, env);
    assert.deepEqual(answer, { entryId: "x", state: "pending" });
    assert.equal(stub.calls.length, 2);
    const [first, second] = stub.calls;
    assert.equal(first.url.pathname, "/hook/team-entry");
    assert.equal(first.init.method, "POST");
    assert.equal((first.init.headers as Record<string, string>).Authorization, "Bearer test-hook-token");
    const body = JSON.parse(first.init.body as string);
    const parsed = memberEntryPostSchema.parse(contract);
    assert.deepEqual(body, { op: "post", requestId: memberEntryId(binding, parsed), ...binding, entry: parsed });
    assert.deepEqual(parsed.body, { interface: "GET /settings", change: "adds theme", sources: [] });
    assert.equal(JSON.parse(second.init.body as string).requestId, body.requestId, "key order must not change requestId");

    stub.restore();
    const refused = stubFetch(() => new Response("entry-secret at body.items.1.observation: this field looks like an access token. Remove it and post again.", { status: 422 }));
    try {
      await assert.rejects(submitEntryCall({ op: "post", entry: contract }, env), (error: unknown) => {
        assert.equal(entryErrorMessage(error), "entry-secret at body.items.1.observation: this field looks like an access token. Remove it and post again.");
        return true;
      });
    } finally { refused.restore(); }

    const silent = stubFetch(() => { throw new TypeError("fetch failed"); });
    try {
      await assert.rejects(submitEntryCall({ op: "post", entry: contract }, env), (error: unknown) => {
        assert.match(entryErrorMessage(error), /^Entry delivery was not confirmed: the endpoint gave no answer\./);
        return true;
      });
    } finally { silent.restore(); }

    const local = stubFetch(() => Response.json({ entry: {} }));
    try {
      const marker = "entry-marker-local";
      await assert.rejects(submitEntryCall({ op: "post", entry: { ...contract, summary: "", body: { ...contract.body, change: marker } } }, env), (error: unknown) => {
        const message = entryErrorMessage(error);
        assert.match(message, /^entry-invalid at /);
        assert.ok(!message.includes(marker));
        return true;
      });
      assert.equal(local.calls.length, 0, "an invalid entry sends nothing");
    } finally { local.restore(); }
  } finally {
    stub.restore();
  }
});
