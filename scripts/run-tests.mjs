import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { lstatSync, realpathSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const teamOperationFailureFile = "team-operation-failure.test.ts";
const mainCheckRealFile = "main-check-real.test.ts";
const processIsolationImage = "buildpack-deps@sha256:c4e7382cc1abefe0bbaaf99324fad5122f9def4d3840fbfad17d3c2fd77b9dc9";
const privateSuites = new Map([
  ["--team-operation-failure", [teamOperationFailureFile]],
  ["--team-leftovers", ["team-witness-hold.test.ts", "team-leftover-hold.test.ts"]],
  ["--main-check-real", [mainCheckRealFile]],
]);
const privateFiles = new Set([...privateSuites.values()].flat());
const requested = [...privateSuites.keys()].filter(flag => process.argv.includes(flag));
if (requested.length > 1) throw new Error("Choose one focused suite at a time.");
const serialFiles = new Set(["client-cli.test.ts"]);
const testFiles = readdirSync(new URL("../tests/", import.meta.url))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
const selectedFiles = requested.length ? privateSuites.get(requested[0]) : testFiles;
const parallelFiles = selectedFiles.filter(name => !privateFiles.has(name) && !serialFiles.has(name));
const serial = selectedFiles.filter((name) => serialFiles.has(name));
const requestedConcurrency = process.argv.find((arg) => arg.startsWith("--concurrency="))?.split("=", 2)[1]
  ?? process.env.INFINITE_TEST_CONCURRENCY;
const concurrency = requestedConcurrency === undefined ? 4 : Number(requestedConcurrency);

if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("Test concurrency must be a positive integer. Set --concurrency or INFINITE_TEST_CONCURRENCY.");
}
const runId = process.env.INFINITE_CHECK_RUN_ID;
const checkout = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const jobDirectory = dirname(checkout);
if (!/^iv-[0-9a-f]{32}$/.test(runId ?? "") || basename(checkout) !== "t" ||
    process.env.TMPDIR !== join(jobDirectory, "x") ||
    !lstatSync(join(jobDirectory, "..", "snapshot.json"), { throwIfNoEntry: false })?.isFile()) {
  throw new Error("Tests require the verified cloud checkout. Dispatch with infinite-check -- npm test.");
}

const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));

async function runInPrivateLinuxContainer(file) {
  if (process.platform !== "linux") return run([file], 1);

  const runnerUid = process.getuid?.() ?? -1;
  const runnerGid = process.getgid?.() ?? -1;
  if (!Number.isInteger(runnerUid) || !Number.isInteger(runnerGid) || runnerUid < 0 || runnerGid < 0) {
    throw new Error("Private process-table tests require a Linux cloud job with a valid UID and GID.");
  }
  const uid = runnerUid === 0 || runnerGid === 0 ? 65534 : runnerUid;
  const gid = runnerUid === 0 || runnerGid === 0 ? 65534 : runnerGid;
  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (git.status !== 0) throw new Error("Unable to read cloud Git version.");
  const nodePath = realpathSync(process.execPath);
  const expectedNode = process.version;
  const expectedGit = git.stdout.trim();
  const shell = `set -eu
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || exit 80
[ "$(git --version)" = "$EXPECTED_GIT" ] || exit 81
[ "$(node --version)" = "$EXPECTED_NODE" ] || exit 82
printf 'PROCESS VIEW image=%s distribution=%s/%s node=%s git=%s uid=%s\\n' "$PROCESS_IMAGE" "$ID" "$VERSION_ID" "$(node --version)" "$(git --version)" "$(id -u)"
mkdir -p /tmp/home
exec node --import tsx --test --test-concurrency=1 tests/${file}`;
  const args = [
    "run", "--rm", "--init", "--platform", "linux/amd64",
    "--label", `io.infinite.check=${runId}`,
    "--user", `${uid}:${gid}`,
    "--read-only", "--network", "none", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "256",
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,mode=1777",
    "--mount", `type=bind,src=${checkout},dst=/checkout,readonly`,
    "--mount", `type=bind,src=${nodePath},dst=/usr/local/bin/node,readonly`,
    "--workdir", "/checkout",
    "--env", "HOME=/tmp/home", "--env", "TMPDIR=/tmp", "--env", "TZ=UTC",
    "--env", "LANG=C.UTF-8", "--env", "CI=1", "--env", "GIT_CONFIG_NOSYSTEM=1",
    "--env", "GIT_CONFIG_GLOBAL=/dev/null", "--env", `EXPECTED_NODE=${expectedNode}`,
    "--env", `EXPECTED_GIT=${expectedGit}`, "--env", `PROCESS_IMAGE=${processIsolationImage}`,
    processIsolationImage, "/bin/sh", "-c", shell,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Private process-table container failed (${signal ?? code})`));
    });
  });
}

async function run(files, fileConcurrency) {
  const report = !process.stdout.isTTY;
  const child = spawn(process.execPath, [tsx, "--test", `--test-concurrency=${fileConcurrency}`, ...files.map((file) => `tests/${file}`)], {
    stdio: ["inherit", report ? "pipe" : "inherit", "inherit"],
  });
  const failed = [];
  const finished = [once(child, "close")];
  if (report) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      process.stdout.write(`${line}\n`);
      const name = /^\s*not ok \d+ - (.*)$/.exec(line)?.[1];
      if (name !== undefined && !/ # (?:SKIP|TODO)\b/i.test(name)) failed.push(name);
    });
    finished.push(once(lines, "close"));
  }
  const [[code, signal]] = await Promise.all(finished);
  if (failed.length) process.stdout.write(`# failed tests (${failed.length}):\n${failed.map((name) => `#   ${name}`).join("\n")}\n`);
  if (code !== 0) throw new Error(`Test process failed (${signal ?? code})`);
}

if (selectedFiles.includes(teamOperationFailureFile)) await runInPrivateLinuxContainer(teamOperationFailureFile);
if (parallelFiles.length) await run(parallelFiles, concurrency);
if (serial.length) await run(serial, 1);
for (const file of selectedFiles) {
  if (file !== teamOperationFailureFile && privateFiles.has(file)) await runInPrivateLinuxContainer(file);
}
