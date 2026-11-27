import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const observer = fileURLToPath(new URL("../scripts/cloud-revision/observe.py", import.meta.url));

test("outbound reconciliation recovers current trusted heads after an outage and deduplicates subsequent scans", async t => {
  const root = await mkdtemp(join(tmpdir(), "observe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "queue");
  const config = join(root, "config.json");
  const secret = join(root, "webhook");
  const launcher = join(root, "trusted-launcher");
  await writeFile(launcher, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  await writeFile(secret, "fixture-webhook", { mode: 0o600 });
  const repo = "example/project";
  const branch = "release/current";
  const ref = "refs/heads/" + branch;
  const enrolled = { repository: repo, origin: "https://example.invalid/project.git", refs: [ref],
    workspace: "sample", runner: "guest", mode: "command", command: ["make", "test"], context: "cloud/check",
    launcher, profileSha256: "0".repeat(64), stateDirectory: state, snapshotRoot: root,
    webhookSecretFile: secret, githubTokenFile: join(root, "missing-token") };
  await writeFile(config, JSON.stringify(enrolled), { mode: 0o600 });

  const makePull = (source: string, target: string, sha: string) => ({
    base: { ref: target, repo: { full_name: repo } },
    head: { sha, ref: "topic", repo: { full_name: source } },
  });
  let online = false;
  let tip = "a".repeat(40);
  const openHead = "b".repeat(40);
  const excluded = makePull("external/fork", branch, "d".repeat(40));
  const server = createServer((req, res) => {
    if (!online) { res.writeHead(503).end(); return; }
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.endsWith("/branches/release%2Fcurrent")) {
      res.end(JSON.stringify({ name: branch, commit: { sha: tip } }));
    } else if (url.pathname.endsWith("/pulls") && url.searchParams.get("state") === "open") {
      const page = url.searchParams.get("page");
      res.end(JSON.stringify(page === "1" ? Array(100).fill(excluded) : [
        makePull(repo, branch, openHead), makePull(repo, "elsewhere", "e".repeat(40)),
        { ...excluded, head: { ...excluded.head, repo: null } },
      ]));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const api = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const scan = () => exec("python3", [observer, "--config", config, "--api", api]);
  const jobs = async () => Promise.all((await readdir(join(state, "jobs"))).filter(name => name.endsWith(".json"))
    .map(async name => JSON.parse(await readFile(join(state, "jobs", name), "utf8"))));

  await assert.rejects(scan(), /503/);
  online = true;
  await scan();
  await scan();
  assert.deepEqual((await jobs()).map(job => [job.sha, job.deliveries.length]).sort(), [[tip, 1], [openHead, 1]]);
  tip = "c".repeat(40);
  await scan();
  assert.deepEqual((await jobs()).map(job => job.sha).sort(), ["a".repeat(40), openHead, tip]);
});
