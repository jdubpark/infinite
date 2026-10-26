import test from "node:test";
import assert from "node:assert/strict";
import { pageOf } from "../packages/host/src/understanding-pages.js";

test("pages by count and bytes with stable cursors across inserts", () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: `k${i}`, body: "x".repeat(10) }));
  const first = pageOf(items, undefined, item => item.id);
  assert.equal(first.items.length, 50);
  const second = pageOf([{ id: "new", body: "" }, ...items], first.next!, item => item.id);
  assert.equal(second.items[0].id, "k50");
  const big = pageOf([{ id: "a", body: "y".repeat(600 * 1024) }, { id: "b", body: "" }], undefined, item => item.id);
  assert.deepEqual(big.items.map(item => item.id), ["a"]);
  assert.equal(pageOf(items, "garbage", item => item.id).items[0].id, "k0");
});

test("keys containing colons and the final page end the cursor chain", () => {
  const items = Array.from({ length: 51 }, (_, i) => ({ id: `diagram:${i}` }));
  const first = pageOf(items, undefined, item => item.id);
  const last = pageOf(items, first.next!, item => item.id);
  assert.deepEqual(last.items.map(item => item.id), ["diagram:50"]);
  assert.equal(last.next, null);
});
