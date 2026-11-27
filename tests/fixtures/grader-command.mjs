#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const JOB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAMES = ["base.bundle", "base-delta.patch", "reference.patch", "result.patch"];
const DIRS = [".", "task", "round-1", "round-2", "round-3", "round-4", "round-5", "round-6"];
const REPORT_RE = /^reports\/round-[1-6]\.(xml|tap)$/;
const FIXED_ENV = {
  PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", CI: "1",
};

const opts = { root: "", uid: process.getuid(), metadata: "closed", record: "", ancestorsWritable: false, toolsMissing: false, hang: 0, digestText: undefined, freeBytes: 1099511627776, freeInodes: 10000000, metadataFile: undefined, noVersion: false };
const args = process.argv.slice(2);
let i = 0;
for (; i < args.length && args[i].startsWith("--"); i++) {
  const flag = args[i];
  if (flag === "--ancestors-writable") opts.ancestorsWritable = true;
  else if (flag === "--root") opts.root = args[++i];
  else if (flag === "--uid") opts.uid = Number(args[++i]);
  else if (flag === "--metadata") opts.metadata = args[++i];
  else if (flag === "--record") opts.record = args[++i];
  else if (flag === "--tools") opts.toolsMissing = args[++i] === "missing";
  else if (flag === "--hang") opts.hang = Number(args[++i]);
  else if (flag === "--digest-text") opts.digestText = args[++i];
  else if (flag === "--metadata-file") opts.metadataFile = args[++i];
  else if (flag === "--free-bytes") opts.freeBytes = Number(args[++i]);
  else if (flag === "--free-inodes") opts.freeInodes = Number(args[++i]);
  else if (flag === "--no-version") opts.noVersion = true;
  else process.exit(64);
}
const [op, ...rest] = args.slice(i);
if (!opts.root) process.exit(64);

const groupsFile = `${opts.root}.groups`;

function exit(code, data) {
  if (data && data.length) process.stdout.write(data, () => process.exit(code));
  else process.exit(code);
}

function jobPath(job, ...parts) {
  return path.join(opts.root, "jobs", job, ...parts);
}

function readable(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function pruneTo(dir, keep) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!keep.includes(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

function probe(canaries) {
  const stat = fs.statSync(opts.root);
  exit(0, Buffer.from(JSON.stringify({
    uid: opts.uid,
    root: opts.root,
    rootMode: (stat.mode & 0o777).toString(8),
    rootOwner: stat.uid,
    readable: canaries.map(readable),
    metadata: opts.metadataFile === undefined ? opts.metadata : fs.readFileSync(opts.metadataFile, "utf8").trim(),
    freeBytes: opts.freeBytes,
    freeInodes: opts.freeInodes,
    ancestorsWritable: opts.ancestorsWritable,
    tools: !opts.toolsMissing,
    ...(opts.noVersion ? {} : { version: 2 }),
  })));
}

async function receive(job, name, maxText) {
  if (!JOB_RE.test(job) || !NAMES.includes(name) || !/^\d+$/.test(maxText)) exit(64);
  const max = Number(maxText);
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > max) exit(3);
    chunks.push(chunk);
  }
  const dir = jobPath(job, "in");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, name), Buffer.concat(chunks), { mode: 0o600 });
  exit(0);
}

function run(job, dir, secondsText, argv) {
  if (!JOB_RE.test(job) || !DIRS.includes(dir) || !/^\d+$/.test(secondsText)) exit(64);
  const seconds = Number(secondsText);
  if (seconds < 1 || seconds > 3600 || argv[0] !== "--" || argv.length < 2) exit(64);
  const home = jobPath(job, "home");
  const tmp = jobPath(job, "tmp");
  const cwd = dir === "." ? jobPath(job, "work") : jobPath(job, "work", dir);
  for (const d of [home, tmp, cwd, jobPath(job, "work", "reports")]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

  const child = spawn(argv[1], argv.slice(2), {
    cwd, env: { ...FIXED_ENV, HOME: home, TMPDIR: tmp }, detached: true, stdio: "inherit",
  });
  fs.appendFileSync(groupsFile, `${child.pid}\n`);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch { }
  }, seconds * 1000);
  child.on("error", () => { clearTimeout(timer); exit(125); });
  child.on("exit", (code) => {
    clearTimeout(timer);
    if (timedOut) exit(124);
    exit(code !== null && code < 64 ? code : 1);
  });
}

function read(job, report, maxText) {
  if (!JOB_RE.test(job) || !REPORT_RE.test(report) || !/^\d+$/.test(maxText)) exit(64);
  const file = jobPath(job, "work", report);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    exit(2);
  }
  if (!stat.isFile()) exit(2);
  if (stat.size > Number(maxText)) exit(3);
  exit(0, fs.readFileSync(file));
}

function exportTrial(job) {
  if (!JOB_RE.test(job)) exit(64);
  const cwd = jobPath(job, "work", "task");
  if (!fs.existsSync(cwd)) exit(2);
  const env = { ...FIXED_ENV, HOME: jobPath(job, "home"), TMPDIR: jobPath(job, "tmp") };
  if (spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/trial"], { cwd, env, stdio: "ignore" }).status !== 0) exit(2);
  const bundle = spawnSync("git", ["bundle", "create", "-", "refs/heads/trial"], { cwd, env, maxBuffer: 64 << 20 });
  exit(bundle.status ?? 1, bundle.stdout);
}

function digest(job) {
  if (!JOB_RE.test(job)) exit(64);
  if (opts.digestText !== undefined) exit(0, Buffer.from(`${opts.digestText}\n`));
  let bytes;
  try {
    bytes = fs.readFileSync(jobPath(job, "in", "base.bundle"));
  } catch {
    exit(2);
  }
  exit(0, Buffer.from(`${createHash("sha256").update(bytes).digest("hex")}\n`));
}

function stop() {
  let text = "";
  try {
    text = fs.readFileSync(groupsFile, "utf8");
  } catch {
    exit(0);
  }
  for (const line of text.split("\n")) {
    const pgid = Number(line);
    if (!Number.isInteger(pgid) || pgid <= 1) continue;
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH" && error.code !== "EPERM") exit(1);
    }
  }
  fs.writeFileSync(groupsFile, "");
  exit(0);
}

function clean(job) {
  if (!JOB_RE.test(job)) exit(64);
  pruneTo(opts.root, ["jobs"]);
  pruneTo(path.join(opts.root, "jobs"), [job]);
  pruneTo(jobPath(job), ["in"]);
  pruneTo(jobPath(job, "in"), ["base.bundle"]);
  exit(0);
}

function remove(job) {
  if (!JOB_RE.test(job)) exit(64);
  fs.rmSync(jobPath(job), { recursive: true, force: true });
  exit(0);
}

if (opts.record) fs.appendFileSync(opts.record, `${JSON.stringify([op, ...rest])}\n`);
if (opts.hang) await new Promise(resolve => setTimeout(resolve, opts.hang * 1000));

switch (op) {
  case "probe":
    if (rest[0] !== "--") exit(64);
    probe(rest.slice(1));
    break;
  case "receive": await receive(rest[0], rest[1], rest[2]); break;
  case "run": run(rest[0], rest[1], rest[2], rest.slice(3)); break;
  case "read": read(rest[0], rest[1], rest[2]); break;
  case "digest": digest(rest[0]); break;
  case "export": exportTrial(rest[0]); break;
  case "stop": stop(); break;
  case "clean": clean(rest[0]); break;
  case "remove": remove(rest[0]); break;
  default: exit(64);
}
