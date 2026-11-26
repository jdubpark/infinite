import assert from "node:assert/strict";
import test from "node:test";
import type { RunRequest } from "../apps/mobile/src/store/requests.js";

test("RunRequest.fields accepts numeric and string values at compile time", () => {
  const fields: RunRequest["fields"] = { minutes: 30, note: "finish review" };
  const request: RunRequest = {
    requestId: "req-extend-1",
    revision: 4,
    path: "/missions/m1/extend",
    label: "Time extension",
    fields,
  };
  const acceptsNumber: number extends RunRequest["fields"][string] ? true : never = true;
  const acceptsString: string extends RunRequest["fields"][string] ? true : never = true;
  const invalidBooleanFields: RunRequest["fields"] = {
    // @ts-expect-error RunRequest.fields rejects boolean values
    enabled: true,
  };
  assert.equal(request.fields.minutes, 30);
  assert.equal(request.fields.note, "finish review");
  assert.equal(acceptsNumber, true);
  assert.equal(acceptsString, true);
  assert.ok(invalidBooleanFields);
});
