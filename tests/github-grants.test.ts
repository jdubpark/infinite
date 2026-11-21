import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mintGithubGrant, readGithubGrantKey, sessionGithubScope } from "../packages/host/src/github-grants.js";
// The proxy is a plain Node script; the host and the proxy must agree on every grant.
import { loadGrantKey, verifyGrant } from "../scripts/github-proxy.mjs";

const key = randomBytes(32);
const now = Date.UTC(2026, 10, 14, 12, 0, 0);
const nowSeconds = Math.floor(now / 1000);
const claims = { sub: "team:delivery", sid: "session-1", project: "product-web", repo: "example/product", ops: ["fetch", "push", "pr"] as ("fetch" | "push" | "pr")[], refs: ["refs/heads/infinite/team-1"] };

/** Signs an arbitrary payload the way the host does, so the proxy's own field checks are what refuses it. */
function signed(payload: unknown, signingKey = key, version = "v2") {
  const body = `${version}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
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
  assert.deepEqual(verifyGrant(`x2.${payload}.${mac}`, key, nowSeconds), { ok: false, reason: "grant-malformed" });
  assert.deepEqual(verifyGrant(`${grant}.extra`, key, nowSeconds), { ok: false, reason: "grant-malformed" });
});

test("grants carry a project, and a version 1 grant, which has none, is refused even with a valid signature", () => {
  const grant = mintGithubGrant(key, claims, now);
  assert.equal(grant.startsWith("v2."), true);
  assert.equal((verifyGrant(grant, key, nowSeconds) as { claims: { project: string } }).claims.project, "product-web");
  const { project: _project, ...v1Claims } = claims;
  assert.deepEqual(verifyGrant(signed({ ...v1Claims, exp: nowSeconds + 600 }, key, "v1"), key, nowSeconds), { ok: false, reason: "grant-version" });
  assert.deepEqual(verifyGrant(signed({ ...claims, exp: nowSeconds + 600 }, key, "v1"), key, nowSeconds), { ok: false, reason: "grant-version" });
  assert.deepEqual(verifyGrant(signed({ ...v1Claims, exp: nowSeconds + 600 }), key, nowSeconds), { ok: false, reason: "grant-fields" });
  assert.deepEqual(verifyGrant(signed({ ...claims, project: "../x", exp: nowSeconds + 600 }), key, nowSeconds), { ok: false, reason: "grant-fields" });
  assert.throws(() => mintGithubGrant(key, { ...claims, project: "" }, now));
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

test("the host and the proxy read the grant key only from a root-owned file below root-owned directories", () => {
  // Tests run without root: `trustedUid` names this process's uid as the one owner accepted besides root. The fixture
  // lives under the home directory because a shared temporary directory is world-writable and fails the rule.
  const uid = process.getuid!();
  const root = realpathSync(mkdtempSync(join(homedir(), ".github-grant-key-")));
  try {
    chmodSync(root, 0o700);
    const keyHex = randomBytes(32).toString("hex");
    const write = (path: string, mode: number) => { writeFileSync(path, `${keyHex}\n`); chmodSync(path, mode); return path; };
    const host = (path: string, trustedUid = uid) => readGithubGrantKey(path, { trustedUid });
    const proxy = (path: string, trustedUid = uid) => loadGrantKey(path, { trustedUid });
    const both = (path: string) => {
      const verdicts = [() => host(path), () => proxy(path)].map(read => { try { return read().toString("hex"); } catch { return "refused"; } });
      assert.equal(verdicts[0], verdicts[1], `host and proxy disagree on ${path}`);
      return verdicts[0];
    };

    const good = write(join(root, "grant.key"), 0o440);
    assert.equal(both(good), keyHex);
    // The same file and directories owned by an account that is neither root nor trusted (the agent-owned key of the
    // review): the production default, trustedUid 0, refuses them.
    if (uid !== 0) {
      assert.throws(() => host(good, 0), /unsafe/);
      assert.throws(() => proxy(good, 0), /grant-key-(?:directory-)?permissions/);
    }
    assert.equal(both(write(join(root, "other-readable.key"), 0o444)), "refused");
    assert.equal(both(write(join(root, "group-writable.key"), 0o460)), "refused");
    const link = join(root, "link.key");
    symlinkSync(good, link);
    assert.equal(both(link), "refused");

    const shared = join(root, "shared");
    mkdirSync(shared);
    const underShared = write(join(shared, "grant.key"), 0o440);
    chmodSync(shared, 0o770);
    assert.equal(both(underShared), "refused");
    chmodSync(shared, 0o750);
    assert.equal(both(underShared), keyHex);
    const linkedDirectory = join(root, "linked");
    symlinkSync(shared, linkedDirectory);
    assert.equal(both(join(linkedDirectory, "grant.key")), "refused");
    assert.equal(both(join(root, "missing.key")), "refused");
    assert.equal(both(`${root}/./grant.key`), "refused");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the intent checker gets no GitHub grant", () => {
  assert.equal(sessionGithubScope({ kind: "team", role: "intent-checker", repository: "example/product" }), undefined);
  assert.ok(sessionGithubScope({ kind: "team", role: "scout", repository: "example/product" })?.ops.includes("fetch"));
});

test("the evaluator gets no grant", () => {
  assert.equal(sessionGithubScope({ kind: "team", role: "evaluator", repository: "example/product" }), undefined);
  const delivery = { mode: "github" as const, repository: "example/product", headBranch: "infinite/team-one" };
  assert.equal(sessionGithubScope({ kind: "team", role: "evaluator", repository: "example/product", delivery }), undefined);
});
