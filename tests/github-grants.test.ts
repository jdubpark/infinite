import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mintGithubGrant } from "../packages/host/src/github-grants.js";
// The proxy is a plain Node script; the host and the proxy must agree on every grant.
import { verifyGrant } from "../scripts/github-proxy.mjs";

const key = randomBytes(32);
const now = Date.UTC(2026, 10, 14, 12, 0, 0);
const nowSeconds = Math.floor(now / 1000);
const claims = { sub: "team:delivery", sid: "session-1", repo: "example/product", ops: ["fetch", "push", "pr"] as ("fetch" | "push" | "pr")[], refs: ["refs/heads/infinite/team-1"] };

/** Signs an arbitrary payload the way the host does, so the proxy's own field checks are what refuses it. */
function signed(payload: unknown, signingKey = key) {
  const body = `v1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${createHmac("sha256", signingKey).update(body).digest("base64url")}`;
}

test("a host-minted grant verifies in the proxy with the same claims", () => {
  const grant = mintGithubGrant(key, { ...claims, ttlSeconds: 3600 }, now);
  const result = verifyGrant(grant, key, nowSeconds + 10);
  assert.deepEqual(result, { ok: true, claims: { ...claims, exp: nowSeconds + 3600 } });
  // The default lifetime is the 24-hour maximum, which the proxy still accepts.
  assert.equal(verifyGrant(mintGithubGrant(key, claims, now), key, nowSeconds).ok, true);
});

test("a tampered grant or another key is refused", () => {
  const grant = mintGithubGrant(key, claims, now);
  const [version, payload, mac] = grant.split(".");
  const widened = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), refs: ["refs/heads/*"] })).toString("base64url");
  assert.deepEqual(verifyGrant(`${version}.${widened}.${mac}`, key, nowSeconds), { ok: false, reason: "grant-signature" });
  const flipped = mac!.slice(0, -2) + (mac!.at(-2) === "A" ? "B" : "A") + mac!.at(-1);
  assert.deepEqual(verifyGrant(`${version}.${payload}.${flipped}`, key, nowSeconds), { ok: false, reason: "grant-signature" });
  assert.deepEqual(verifyGrant(grant, randomBytes(32), nowSeconds), { ok: false, reason: "grant-signature" });
  assert.deepEqual(verifyGrant(`v2.${payload}.${mac}`, key, nowSeconds), { ok: false, reason: "grant-malformed" });
  assert.deepEqual(verifyGrant(`${grant}.extra`, key, nowSeconds), { ok: false, reason: "grant-malformed" });
});

test("an expired grant, or one that lives longer than 24 hours, is refused", () => {
  const grant = mintGithubGrant(key, { ...claims, ttlSeconds: 60 }, now);
  assert.deepEqual(verifyGrant(grant, key, nowSeconds + 60), { ok: false, reason: "grant-expired" });
  assert.deepEqual(verifyGrant(signed({ ...claims, exp: nowSeconds + 24 * 3600 + 1 }), key, nowSeconds), { ok: false, reason: "grant-lifetime" });
  assert.throws(() => mintGithubGrant(key, { ...claims, ttlSeconds: 24 * 3600 + 1 }, now));
});

test("unknown or malformed fields are refused even with a valid signature", () => {
  const exp = nowSeconds + 600;
  assert.equal(verifyGrant(signed({ ...claims, exp }), key, nowSeconds).ok, true);
  assert.deepEqual(verifyGrant(signed({ ...claims, exp, admin: true }), key, nowSeconds), { ok: false, reason: "grant-fields" });
  assert.deepEqual(verifyGrant(signed({ ...claims, exp, ops: ["fetch", "delete"] }), key, nowSeconds), { ok: false, reason: "grant-fields" });
  assert.deepEqual(verifyGrant(signed({ ...claims, exp, refs: ["refs/*"] }), key, nowSeconds), { ok: false, reason: "grant-fields" });
  assert.deepEqual(verifyGrant(signed({ ...claims, exp, ops: ["fetch"] }), key, nowSeconds), { ok: false, reason: "grant-fields" });
  assert.deepEqual(verifyGrant(signed({ ...claims, exp, repo: "example/product/../other" }), key, nowSeconds), { ok: false, reason: "grant-fields" });
  assert.throws(() => mintGithubGrant(key, { ...claims, refs: ["refs/heads/a\nb"] }, now));
});
