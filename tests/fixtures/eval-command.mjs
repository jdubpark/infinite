#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TRIAL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const LOGIN_PATHS = [".claude/.credentials.json", ".codex/auth.json", ".local/share/opencode/auth.json"];
const CAP = 10_000;
const GIT_ENV = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" };

const opts = { root: "", uid: process.getuid(), home: "", template: "", tmp: "", metadata: "closed", fetch: "refused", ancestorsWritable: false, record: "" };
const args = process.argv.slice(2);
let i = 0;
for (; i < args.length && args[i].startsWith("--"); i++) {
  const flag = args[i];
  if (flag === "--ancestors-writable") opts.ancestorsWritable = true;
  else if (flag === "--root") opts.root = args[++i];
  else if (flag === "--uid") opts.uid = Number(args[++i]);
  else if (flag === "--home") opts.home = args[++i];
  else if (flag === "--template") opts.template = args[++i];
  else if (flag === "--tmp") opts.tmp = args[++i];
  else if (flag === "--metadata") opts.metadata = args[++i];
  else if (flag === "--fetch") opts.fetch = args[++i];
  else if (flag === "--record") opts.record = args[++i];
  else process.exit(64);
}
const [op, ...rest] = args.slice(i);
if (!opts.root || !opts.home || !opts.template || !opts.tmp) process.exit(64);

function exit(code, data) {
  if (data && data.length) process.stdout.write(data, () => process.exit(code));
  else process.exit(code);
}

if (opts.record) fs.appendFileSync(opts.record, `${JSON.stringify({ argv: [op, ...rest], cwd: process.cwd() })}\n`);

const trialsDir = () => path.join(opts.root, "trials");

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

function countEntries(dir) {
  const st = lstatOrNull(dir);
  if (!st || !st.isDirectory()) return 0;
  return fs.readdirSync(dir).length;
}

function readable(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function entriesUnder(dir) {
  const out = [];
  const visit = (abs, rel) => {
    let items;
    try {
      items = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (out.length >= CAP) return;
      const next = rel ? `${rel}/${item.name}` : item.name;
      out.push({ rel: next, dir: item.isDirectory(), file: item.isFile() });
      if (item.isDirectory()) visit(path.join(abs, item.name), next);
    }
  };
  visit(dir, "");
  return out;
}

function keepPath(rel) {
  if (LOGIN_PATHS.some(login => login === rel || login.startsWith(`${rel}/`))) return true;
  return lstatOrNull(path.join(opts.template, rel)) !== null;
}

function differs(a, b) {
  try {
    return !fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return true;
  }
}

function obstructions() {
  let n = 0;
  for (const login of LOGIN_PATHS) {
    const parts = login.split("/");
    let prefix = "";
    for (let k = 0; k < parts.length; k++) {
      prefix = prefix ? `${prefix}/${parts[k]}` : parts[k];
      const st = lstatOrNull(path.join(opts.home, prefix));
      if (k === parts.length - 1) {
        if (st && !st.isFile()) n++;
      } else if (st && !st.isDirectory()) {
        n++;
        break;
      }
    }
  }
  return n;
}

function leftovers() {
  let count = 0;
  const home = lstatOrNull(opts.home);
  if (home && home.isDirectory()) {
    for (const entry of entriesUnder(opts.home)) if (!keepPath(entry.rel)) count++;
  }
  const template = lstatOrNull(opts.template);
  if (template && template.isDirectory()) {
    for (const entry of entriesUnder(opts.template)) {
      if (entry.file && differs(path.join(opts.template, entry.rel), path.join(opts.home, entry.rel))) count++;
    }
  }
  if (fs.existsSync(opts.root)) count += fs.readdirSync(opts.root).filter(name => name !== "trials").length;
  count += countEntries(opts.tmp);
  count += obstructions();
  return Math.min(count, CAP);
}

function probe(rest) {
  let fetch = "skipped";
  if (rest[0] === "--fetch") {
    if (rest.length < 2) exit(64);
    try {
      fs.readFileSync(0, "utf8");
    } catch {
    }
    fetch = opts.fetch;
    rest = rest.slice(2);
  }
  if (rest[0] !== "--") exit(64);
  const canaries = rest.slice(1);
  const stat = fs.statSync(opts.root);
  const space = fs.statfsSync(opts.root);
  exit(0, Buffer.from(`${JSON.stringify({
    version: 1,
    uid: opts.uid,
    root: opts.root,
    rootMode: (stat.mode & 0o777).toString(8),
    rootOwner: stat.uid,
    readable: canaries.map(readable),
    metadata: opts.metadata,
    freeBytes: space.bavail * space.bsize,
    freeInodes: space.ffree,
    ancestorsWritable: opts.ancestorsWritable,
    tools: true,
    trials: countEntries(trialsDir()),
    leftovers: leftovers(),
    fetch,
  })}\n`));
}

async function receive(trial, maxText) {
  if (!TRIAL_RE.test(trial) || !/^\d+$/.test(maxText)) exit(64);
  const max = Number(maxText);
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > max) exit(3);
    chunks.push(chunk);
  }
  const dir = path.join(trialsDir(), trial, "in");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "base.bundle"), Buffer.concat(chunks), { mode: 0o600 });
  exit(0);
}

function prepare(trial) {
  if (!TRIAL_RE.test(trial)) exit(64);
  const dir = path.join(trialsDir(), trial);
  const bundle = path.join(dir, "in", "base.bundle");
  const work = path.join(dir, "work");
  const st = lstatOrNull(bundle);
  if (!st || !st.isFile() || lstatOrNull(work)) exit(64);
  const git = (cwd, gitArgs) => spawnSync("git", gitArgs, { cwd, env: GIT_ENV, stdio: "ignore" });
  for (const step of [
    ["clone", "--quiet", "--template=", "--no-checkout", "--branch", "trial", "--", "in/base.bundle", "work"],
    ["-C", "work", "remote", "remove", "origin"],
    ["-C", "work", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", "trial"],
    ["-C", "work", "branch", "-D", "trial"],
  ]) {
    if (git(dir, step).status !== 0) exit(125);
  }
  fs.rmSync(path.join(dir, "in"), { recursive: true, force: true });
  fs.chmodSync(work, 0o711);
  exit(0);
}

function check(trial, rest) {
  if (!TRIAL_RE.test(trial) || rest[0] !== "--") exit(64);
  const objects = rest.slice(1);
  if (objects.length > 200 || !objects.every(object => OBJECT_RE.test(object))) exit(64);
  const work = path.join(trialsDir(), trial, "work");
  const st = lstatOrNull(work);
  if (!st || !st.isDirectory()) exit(64);
  for (const object of objects) {
    if (spawnSync("git", ["-C", work, "cat-file", "-e", object], { env: GIT_ENV, stdio: "ignore" }).status === 0) exit(1);
  }
  const remotes = spawnSync("git", ["-C", work, "remote"], { env: GIT_ENV, encoding: "utf8" });
  if (remotes.stdout.trim() !== "") exit(1);
  exit(0);
}

function cwdTrial() {
  const real = fs.realpathSync(process.cwd());
  const relative = path.relative(path.join(fs.realpathSync(opts.root), "trials"), real).split(path.sep);
  if (relative.length < 2 || !TRIAL_RE.test(relative[0]) || relative[1] !== "work") exit(64);
}

function run(rest) {
  if (rest[0] !== "--" || rest.length < 2) exit(64);
  cwdTrial();
  const result = spawnSync(rest[1], rest.slice(2), { stdio: "inherit" });
  exit(result.status ?? 1);
}

function setup(rest) {
  if (rest[0] !== "--" || rest.length < 2) exit(64);
  cwdTrial();
  try {
    fs.readFileSync(0, "utf8");
  } catch {
  }
  const result = spawnSync(rest[1], rest.slice(2), { stdio: ["ignore", "inherit", "inherit"] });
  exit(result.status ?? 1);
}

function stop() {
  exit(0);
}

function clean() {
  if (fs.existsSync(opts.root)) {
    for (const name of fs.readdirSync(opts.root)) {
      if (name !== "trials") fs.rmSync(path.join(opts.root, name), { recursive: true, force: true });
    }
  }
  const trials = lstatOrNull(trialsDir());
  if (trials && trials.isSymbolicLink()) exit(64);
  if (trials && trials.isDirectory()) {
    for (const name of fs.readdirSync(trialsDir())) fs.rmSync(path.join(trialsDir(), name), { recursive: true, force: true });
  }
  if (lstatOrNull(opts.tmp)?.isDirectory()) {
    for (const name of fs.readdirSync(opts.tmp)) fs.rmSync(path.join(opts.tmp, name), { recursive: true, force: true });
  }
  exit(0);
}

function clearObstructions() {
  for (const login of LOGIN_PATHS) {
    const parts = login.split("/");
    let prefix = "";
    for (let k = 0; k < parts.length; k++) {
      prefix = prefix ? `${prefix}/${parts[k]}` : parts[k];
      const abs = path.join(opts.home, prefix);
      const st = lstatOrNull(abs);
      if (k === parts.length - 1) {
        if (st && !st.isFile()) fs.rmSync(abs, { recursive: true, force: true });
      } else if (st && !st.isDirectory()) {
        fs.rmSync(abs, { force: true });
        break;
      }
    }
  }
}

function pruneHome(dir, rel) {
  for (const name of fs.readdirSync(dir)) {
    const next = rel ? `${rel}/${name}` : name;
    const abs = path.join(dir, name);
    if (LOGIN_PATHS.includes(next)) continue;
    const st = fs.lstatSync(abs);
    if (st.isDirectory() && LOGIN_PATHS.some(login => login.startsWith(`${next}/`))) {
      pruneHome(abs, next);
      continue;
    }
    fs.rmSync(abs, { recursive: true, force: true });
  }
}

function scrub() {
  const template = lstatOrNull(opts.template);
  if (!template || !template.isDirectory()) exit(125);
  const home = lstatOrNull(opts.home);
  if (!home || !home.isDirectory()) exit(125);
  clearObstructions();
  pruneHome(opts.home, "");
  fs.cpSync(opts.template, opts.home, { recursive: true, force: true, verbatimSymlinks: true });
  exit(0);
}

switch (op) {
  case "probe": probe(rest); break;
  case "receive": await receive(rest[0], rest[1]); break;
  case "prepare": prepare(rest[0]); break;
  case "check": check(rest[0], rest.slice(1)); break;
  case "exec": run(rest); break;
  case "setup": setup(rest); break;
  case "stop": stop(); break;
  case "clean": clean(); break;
  case "scrub": scrub(); break;
  default: exit(64);
}
