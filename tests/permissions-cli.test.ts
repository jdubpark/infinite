import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startHost, type Host } from "./helpers.js";

const exec = promisify(execFile);
const INACTIVE = "The permission agent is not ready on this host, so it serves no request. Run infinite permissions status to see why. Requests are handled as before; this record takes effect when the host is ready.";

test("infinite permissions delegates, reports, and revokes workspaces through the owner CLI", { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "permissions-cli-"));
  const shop = join(root, "shop-api"), web = join(root, "web-app");
  mkdirSync(shop, { mode: 0o700 });
  mkdirSync(web, { mode: 0o700 });
  let host: Host | undefined;
  try {
    host = await startHost({ config: { projects: [
      { id: "shop-api", name: "Shop API", path: shop },
      { id: "web-app", name: "Web App", path: web },
    ] } });
    const clientFile = join(host.root, "permissions-client.json");
    writeFileSync(clientFile, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
    const cli = [process.execPath, "--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", clientFile];
    const permissions = (...args: string[]) => exec(cli[0], [...cli.slice(1), "permissions", ...args]);
    const rejected = (message: RegExp, ...args: string[]) =>
      assert.rejects(permissions(...args), (error: { stderr: string; code: number }) => error.code === 1 && message.test(error.stderr));

    // Argument errors are refused before any request reaches the host.
    await rejected(/Choose one of --workspace W or --all/, "delegate", "--workspace", "shop-api", "--all");
    await rejected(/Choose one of --workspace W or --all/, "delegate");
    await rejected(/Choose either --direction TEXT or --clear-direction/, "delegate", "--all", "--direction", "Read files.", "--clear-direction");
    await rejected(/Usage: infinite permissions revoke/, "revoke");
    await rejected(/--request-id must be a UUID/, "delegate", "--all", "--request-id", "not-a-uuid");

    // Delegate every workspace. A control character in the direction prints as a space.
    const delegated = await permissions("delegate", "--all", "--direction", "Read\u0007files.");
    assert.match(delegated.stdout, /^Shop API {2}shop-api {2}delegated$/m);
    assert.match(delegated.stdout, /^Web App {2}web-app {2}delegated$/m);
    assert.match(delegated.stdout, /^ {2}Direction: Read files\.$/m);
    assert.doesNotMatch(delegated.stdout, /\u0007/);
    assert.equal(delegated.stdout.trimEnd().split("\n").at(-1), INACTIVE);

    const status = await permissions("status");
    assert.match(status.stdout, /^Shop API {2}shop-api {2}delegated$/m);
    assert.match(status.stdout, /^ {2}Shop API {2}shop-api {2}covered$/m);
    assert.equal(status.stdout.trimEnd().split("\n").at(-1), INACTIVE);
    const json = JSON.parse((await permissions("status", "--json")).stdout);
    assert.equal(json.agent, "inactive");
    assert.deepEqual(json.workspaces.map((view: { state: string }) => view.state), ["delegated", "delegated"]);

    // Revoke one workspace. The other keeps its delegation.
    const revoked = await permissions("revoke", "--workspace", "web-app");
    assert.match(revoked.stdout, /^Web App {2}web-app {2}not-delegated$/m);
    assert.match(revoked.stdout, /^ {2}Web App {2}web-app {2}not-covered$/m);
    assert.equal(revoked.stdout.trimEnd().split("\n").at(-1), INACTIVE);
    const after = await permissions("status");
    assert.match(after.stdout, /^Shop API {2}shop-api {2}delegated$/m);
    assert.match(after.stdout, /^Web App {2}web-app {2}not-delegated$/m);

    // Delegate one workspace with its direction cleared. The output names only that workspace and no direction.
    const single = await permissions("delegate", "--workspace", "web-app", "--clear-direction");
    assert.match(single.stdout, /^Web App {2}web-app {2}delegated$/m);
    assert.doesNotMatch(single.stdout, /Shop API|Direction:/);
    assert.equal(single.stdout.trimEnd().split("\n").at(-1), INACTIVE);
    assert.match((await permissions("status")).stdout, /^Shop API {2}shop-api {2}delegated$/m);
  } finally {
    if (host) await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
