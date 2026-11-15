// Lets the host see the processes that a team operation started, also after the API process that started them is gone.
// Node built-ins, the pure sudo profile reader and type imports only: the census also runs alone, as the agent account, through a sudo wrapper.
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sudoShape } from "./sudo-profile.js";
import type { TeamCommand } from "./team-types.js";

/** One process as the census reads it. */
export interface ProcessRow {
  pid: number; ppid: number; pgid: number;
  /** Session id. Absent where the platform does not report one (macOS). */
  sid?: number;
  uid: number;
  /** Opaque start token. Within one boot, the same pid with the same token is the same process. */
  start: string;
  command: string;
}
export interface ProcessTable {
  /** Names this boot. No process outlives it, so a witness from another boot has nothing left to find. */
  boot: string;
  rows: ProcessRow[];
}
/** What the host recorded about the processes one operation started. Sealed with the operation's intent. */
export interface ProcessWitness {
  boot: string;
  /** Each command the host started for the operation: its direct child. */
  processes: { pid: number; start: string }[];
  /** Session and process-group ids the host saw among those children and their descendants. */
  sessions: number[];
  groups: number[];
  /** Set when a list reached WITNESS_LIMIT. Nothing is dropped to make room; the witness then no longer covers the operation. */
  overflow?: true;
}
export type CensusReason = "recorded-process" | "recorded-session" | "recorded-group" | "working-directory" | "open-file" | "command-line" | "unreadable";
export interface CensusFinding { pid: number; reason: CensusReason }
/**
 * `ok: true` with no findings means the census looked everywhere it claims to and found no process.
 * An `unreadable` finding is a process the census could not inspect: it is not evidence that the process uses the
 * directory, only that the census cannot rule it out.
 * `ok: false` means it could not finish; it proves nothing and callers must treat the processes as possibly running.
 */
export type CensusResult = { ok: true; findings: CensusFinding[] } | { ok: false; problem: string };

/** The wrapper's file name, beside the launcher that a sudo command prefix names. */
export const CENSUS_WRAPPER = "process-census";
/** The most entries a witness keeps in each list. A full list marks the witness as overflowed instead of dropping an entry. */
export const WITNESS_LIMIT = 4096;

const REASONS = new Set<string>(["recorded-process", "recorded-session", "recorded-group", "working-directory", "open-file", "command-line", "unreadable"]);
const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";
const EXEC_LIMIT_MS = 20_000;
const TABLE_BUFFER_BYTES = 64 * 1024 * 1024;
const WRAPPER_LIMIT_MS = 10_000;
/** A process can fork and exit between the listing and the reads of one pass; a second pass sees what the first missed. */
const SECOND_PASS_MS = 100;
const WRAPPER_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_WRAPPER_FINDINGS = 10_000;
const MAX_INPUT_BYTES = 4096;

let boot: string | undefined;
/**
 * This boot's token, read once. "unsupported" where the host cannot read one; a witness then never matches a table,
 * and the table read itself rejects there, so the census reports that it could not finish.
 */
export function bootId(): string {
  if (boot !== undefined) return boot;
  try {
    if (process.platform === "linux") boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    else if (process.platform === "darwin") boot = /sec = (\d+)/.exec(execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5000 }))?.[1];
  } catch { /* Reported as unsupported below. */ }
  return boot ||= "unsupported";
}
/** A witness with nothing recorded yet. */
export function newWitness(): ProcessWitness {
  return { boot: bootId(), processes: [], sessions: [], groups: [] };
}
/** Every process on the host: Linux reads /proc, macOS runs ps. Rejects on another platform or when the read fails. */
export async function readProcessTable(): Promise<ProcessTable> {
  const id = bootId();
  if (id === "unsupported") throw new Error("the boot cannot be named");
  if (process.platform === "linux") return { boot: id, rows: await linuxRows() };
  if (process.platform === "darwin") return { boot: id, rows: await darwinRows() };
  throw new Error(`unsupported platform: ${process.platform}`);
}
/** The start token of a live process, or undefined when no such process exists. */
export async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try { return parseLinuxStat(await readFile(`/proc/${pid}/stat`, "utf8")).start; } catch (error) { if (isGone(error)) return undefined; throw error; }
  }
  if (process.platform === "darwin") {
    try { return (await run(PS, ["-p", String(pid), "-o", "lstart="])).trim() || undefined; } catch (error) { if ((error as { code?: unknown }).code === 1) return undefined; throw error; }
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}
/**
 * Records a command the host started detached: it leads its own session and process group, so both ids are its pid
 * and need no read. With a start token the process itself is recorded too. Returns true when the witness changed. Pure.
 */
export function recordCommand(witness: ProcessWitness, pid: number, start?: string): boolean {
  let changed = addUnique(witness, witness.groups, pid);
  changed = addUnique(witness, witness.sessions, pid) || changed;
  if (start === undefined || witness.processes.some(recorded => recorded.pid === pid && recorded.start === start)) return changed;
  if (witness.processes.length >= WITNESS_LIMIT) return markOverflow(witness) || changed;
  witness.processes.push({ pid, start });
  return true;
}
/**
 * Adds to the witness the session and group ids of every process it already accounts for (a recorded process, or a
 * member of a recorded session or group) and of every descendant of those in the table.
 * Returns true when the witness changed. A table from another boot changes nothing. Pure.
 */
export function extendWitness(witness: ProcessWitness, table: ProcessTable): boolean {
  if (table.boot !== witness.boot) return false;
  const children = new Map<number, ProcessRow[]>();
  for (const row of table.rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const queue = table.rows.filter(row => accountedFor(witness, row) !== undefined);
  const seen = new Set<number>();
  let changed = false;
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (seen.has(next.pid)) continue;
    seen.add(next.pid);
    changed = addUnique(witness, witness.groups, next.pgid) || changed;
    if (next.sid !== undefined) changed = addUnique(witness, witness.sessions, next.sid) || changed;
    queue.push(...(children.get(next.pid) ?? []));
  }
  return changed;
}
/**
 * The live processes the witness accounts for: a recorded process (same pid and start token), or any process in a
 * recorded session or group. Empty when the table is from another boot. Pure.
 */
export function witnessFindings(witness: ProcessWitness, table: ProcessTable): CensusFinding[] {
  if (table.boot !== witness.boot) return [];
  const findings: CensusFinding[] = [];
  for (const row of table.rows) {
    if (row.pid === process.pid) continue;
    const reason = accountedFor(witness, row);
    if (reason) findings.push({ pid: row.pid, reason });
  }
  return findings;
}
function accountedFor(witness: ProcessWitness, row: ProcessRow): CensusReason | undefined {
  return witness.processes.some(recorded => recorded.pid === row.pid && recorded.start === row.start) ? "recorded-process"
    : row.sid !== undefined && witness.sessions.includes(row.sid) ? "recorded-session"
      : witness.groups.includes(row.pgid) ? "recorded-group" : undefined;
}
/**
 * The processes of the calling user that use `directory`: it or something under it is their working directory, an open
 * file, or part of a command-line argument. A process of the calling user that cannot be inspected is a finding
 * ("unreadable"). Processes of other users are not inspected; that is the caller's limit to state.
 */
export async function directoryCensus(directory: string): Promise<CensusResult> {
  if (process.platform !== "linux" && process.platform !== "darwin") return { ok: false, problem: "unsupported platform" };
  let target: string;
  try { target = await realpath(directory); } catch { target = directory; }
  if (!isAbsolute(target)) return { ok: false, problem: "directory is not absolute" };
  target = resolve(target);
  try {
    return { ok: true, findings: process.platform === "linux" ? await linuxCensus(target) : await darwinCensus(target) };
  } catch (error) {
    return { ok: false, problem: problemText(error) };
  }
}
/**
 * Looks for what is left of an operation: `witnessFindings` over a fresh table, plus `directoryCensus` of the run
 * directory, in this process and, with a sudo prefix, also under the account that ran the operation's commands. That
 * part is the wrapper `CENSUS_WRAPPER` beside the prefix's executable, run with the prefix's sudo options; the
 * directory goes on its standard input. A missing wrapper, a refused sudo, any other prefix, or a failed read gives
 * `ok: false`. It reports no process only after two passes found none and when the witness did not overflow.
 */
export async function operationCensus(witness: ProcessWitness, directory: string, prefix?: TeamCommand): Promise<CensusResult> {
  const first = await censusPass(witness, directory, prefix);
  if (!first.ok || first.findings.some(finding => finding.reason !== "unreadable")) return first;
  if (witness.overflow) return { ok: false, problem: "the operation started more processes than the host records" };
  if (first.findings.length > 0) return first;
  await new Promise(resolvePromise => setTimeout(resolvePromise, SECOND_PASS_MS));
  return censusPass(witness, directory, prefix);
}
async function censusPass(witness: ProcessWitness, directory: string, prefix?: TeamCommand): Promise<CensusResult> {
  let recorded: CensusFinding[];
  try {
    recorded = witnessFindings(witness, await readProcessTable());
  } catch (error) {
    return { ok: false, problem: `process table: ${problemText(error)}` };
  }
  const parts = [await directoryCensus(directory), ...(prefix === undefined ? [] : [await prefixCensus(directory, prefix)])];
  const byPid = new Map<number, CensusReason>();
  for (const finding of recorded) byPid.set(finding.pid, finding.reason);
  for (const part of parts) {
    if (!part.ok) return part;
    for (const finding of part.findings) if (!byPid.has(finding.pid)) byPid.set(finding.pid, finding.reason);
  }
  return { ok: true, findings: [...byPid].map(([pid, reason]) => ({ pid, reason })) };
}
/** The census as the team service uses it; tests replace it. */
export interface HostProcesses {
  table(): Promise<ProcessTable>;
  start(pid: number): Promise<string | undefined>;
  census(witness: ProcessWitness, directory: string, prefix?: TeamCommand): Promise<CensusResult>;
}
export const hostProcesses: HostProcesses = { table: readProcessTable, start: processStart, census: operationCensus };

function addUnique(witness: ProcessWitness, list: number[], value: number): boolean {
  if (list.includes(value)) return false;
  if (list.length >= WITNESS_LIMIT) return markOverflow(witness);
  list.push(value);
  return true;
}
function markOverflow(witness: ProcessWitness): boolean {
  if (witness.overflow) return false;
  witness.overflow = true;
  return true;
}

function parseLinuxStat(text: string): { ppid: number; pgid: number; sid: number; start: string } {
  // The command name may contain spaces and parentheses, so the fields start after the last ")". Field 3 is the first here.
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]), pgid = Number(fields[2]), sid = Number(fields[3]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid) || !Number.isInteger(sid) || !fields[19]) throw new Error("unreadable process stat");
  // Field 22 is the start time.
  return { ppid, pgid, sid, start: fields[19] };
}

async function linuxRows(): Promise<ProcessRow[]> {
  const rows: ProcessRow[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const row = await linuxRow(Number(entry));
    if (row) rows.push(row);
  }
  // Where /proc hides other accounts, their processes are missing here without an error. The first process always exists.
  if (!rows.some(row => row.pid === 1)) throw new Error("the process table does not show other accounts");
  return rows;
}

async function linuxRow(pid: number): Promise<ProcessRow | undefined> {
  try {
    const dir = `/proc/${pid}`;
    const { ppid, pgid, sid, start } = parseLinuxStat(await readFile(`${dir}/stat`, "utf8"));
    const owner = await stat(dir);
    const command = await readFile(`${dir}/cmdline`, "utf8").then(text => text.replace(/\0/g, " ").trimEnd(), () => "");
    return { pid, ppid, pgid, sid, uid: owner.uid, start, command };
  } catch (error) {
    if (isGone(error)) return undefined;
    throw error;
  }
}

async function darwinRows(): Promise<ProcessRow[]> {
  const rows: ProcessRow[] = [];
  const text = await run(PS, ["-axo", "pid=,ppid=,pgid=,uid=,lstart=,command="]);
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s*(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), uid: Number(match[4]), start: match[5] ?? "", command: match[6] ?? "" });
  }
  return rows;
}

function exec(file: string, args: string[]): Promise<{ stdout: string; error?: Error & { code?: unknown } }> {
  return new Promise(resolvePromise => {
    execFile(file, args, { timeout: EXEC_LIMIT_MS, maxBuffer: TABLE_BUFFER_BYTES, encoding: "utf8" }, (error, stdout) => {
      resolvePromise({ stdout: String(stdout), error: error ?? undefined });
    });
  });
}

async function run(file: string, args: string[]): Promise<string> {
  const { stdout, error } = await exec(file, args);
  if (error) throw error;
  return stdout;
}

async function linuxCensus(directory: string): Promise<CensusFinding[]> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("the user id cannot be read");
  const findings: CensusFinding[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    const reason = await linuxReason(Number(entry), uid, directory);
    if (reason) findings.push({ pid: Number(entry), reason });
  }
  return findings;
}

async function linuxReason(pid: number, uid: number, directory: string): Promise<CensusReason | undefined> {
  const base = `/proc/${pid}`;
  try {
    // A process that hides its memory from its own account (ssh-agent, a sandboxed browser) is shown as owned by root.
    // Its status still names its account. It cannot be inspected, so it is reported, never skipped.
    if ((await stat(base)).uid !== uid) return await linuxAccount(base, uid) ? "unreadable" : undefined;
  } catch (error) {
    return isGone(error) ? undefined : "unreadable";
  }
  const view = await linuxLinks(base);
  if (view.missing) {
    // An exited leader has no links of its own while its other threads run on with the directory and files they share.
    // A process that has exited altogether has no thread left to list.
    try {
      for (const thread of await readdir(`${base}/task`)) {
        if (Number(thread) === pid) continue;
        const other = await linuxLinks(`${base}/task/${thread}`);
        view.paths.push(...other.paths);
        view.unreadable ||= other.unreadable;
      }
    } catch (error) {
      if (!isGone(error)) view.unreadable = true;
    }
  }
  let args: string[] = [];
  try { args = (await readFile(`${base}/cmdline`, "utf8")).split("\0"); } catch (error) { if (!isGone(error)) view.unreadable = true; }
  for (const reason of ["working-directory", "open-file"] as const)
    if (view.paths.some(path => path.reason === reason && underDirectory(path.path, directory))) return reason;
  if (args.some(arg => mentionsDirectory(arg, directory, "/"))) return "command-line";
  return view.unreadable ? "unreadable" : undefined;
}

/** The working directory and open files under one /proc directory of a process or thread. `missing` marks a link that was not there. */
async function linuxLinks(base: string): Promise<{ paths: { reason: "working-directory" | "open-file"; path: string }[]; missing: boolean; unreadable: boolean }> {
  const view = { paths: [] as { reason: "working-directory" | "open-file"; path: string }[], missing: false, unreadable: false };
  const note = (error: unknown) => { if (isGone(error)) view.missing = true; else view.unreadable = true; };
  try { view.paths.push({ reason: "working-directory", path: withoutDeleted(await readlink(`${base}/cwd`)) }); } catch (error) { note(error); }
  try {
    for (const fd of await readdir(`${base}/fd`)) {
      // A descriptor closed between the listing and the read is gone, not hidden.
      try { view.paths.push({ reason: "open-file", path: withoutDeleted(await readlink(`${base}/fd/${fd}`)) }); } catch (error) { if (!isGone(error)) view.unreadable = true; }
    }
  } catch (error) {
    note(error);
  }
  return view;
}

/** True when the process's status names `uid` as one of its user ids, or cannot be read while the process exists. */
async function linuxAccount(base: string, uid: number): Promise<boolean> {
  try {
    const line = (await readFile(`${base}/status`, "utf8")).split("\n").find(text => text.startsWith("Uid:"));
    return line === undefined || line.split(/\s+/).slice(1).some(value => Number(value) === uid);
  } catch (error) {
    return !isGone(error);
  }
}

async function darwinCensus(directory: string): Promise<CensusFinding[]> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("the user id cannot be read");
  // Zombies have no working directory or files to read, and lsof does not list them; they are not unreadable.
  const rows = (await readProcessTable()).rows.filter(row => row.uid === uid && row.pid !== process.pid && !isCensusHelper(row) && !row.command.endsWith("<defunct>"));
  const records = await lsofRecords(uid);
  const findings: CensusFinding[] = [];
  for (const row of rows) {
    const record = records.get(row.pid);
    let reason: CensusReason | undefined;
    if (record?.cwd !== undefined && underDirectory(record.cwd, directory)) reason = "working-directory";
    else if (record?.files.some(path => underDirectory(path, directory))) reason = "open-file";
    else if (mentionsDirectory(row.command, directory, "/ ")) reason = "command-line";
    else if (!record && await stillSameProcess(row)) reason = "unreadable";
    if (reason) findings.push({ pid: row.pid, reason });
  }
  return findings;
}

/** The census's own ps and lsof calls, when they are still children of this process. */
function isCensusHelper(row: ProcessRow): boolean {
  return row.ppid === process.pid && /^(\/bin\/ps|\/usr\/sbin\/lsof)( |$)/.test(row.command);
}

/** A failed look is not an exit: only a start token that is gone or different shows the listed process ended. */
async function stillSameProcess(row: ProcessRow): Promise<boolean> {
  try { return (await processStart(row.pid)) === row.start; } catch { return true; }
}

async function lsofRecords(uid: number): Promise<Map<number, { cwd?: string; files: string[] }>> {
  const { stdout, error } = await exec(LSOF, ["-a", "-u", String(uid), "-Fpfn"]);
  // lsof exits non-zero for some unreadable processes and still prints valid records; only a failure to run or no output is a failure.
  if (error && (typeof error.code !== "number" || !stdout.trim())) throw new Error(`lsof: ${error.message.slice(0, 120)}`);
  if (!stdout.trim()) throw new Error("lsof printed nothing");
  const records = new Map<number, { cwd?: string; files: string[] }>();
  let pid: number | undefined;
  let fd = "";
  for (const line of stdout.split("\n")) {
    const tag = line.charAt(0), value = line.slice(1);
    if (tag === "p") {
      pid = Number(value);
      if (!records.has(pid)) records.set(pid, { files: [] });
    } else if (tag === "f") {
      fd = value;
    } else if (tag === "n" && pid !== undefined && value.startsWith("/")) {
      const record = records.get(pid);
      if (!record) continue;
      if (fd === "cwd") record.cwd = withoutDeleted(value);
      else record.files.push(withoutDeleted(value));
    }
  }
  return records;
}

function withoutDeleted(path: string): string {
  return path.replace(/ \(deleted\)$/, "");
}

function underDirectory(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory.endsWith("/") ? directory : `${directory}/`);
}

/** True when the text contains the directory followed by the end of the text or one of the terminator characters. */
function mentionsDirectory(text: string, directory: string, terminators: string): boolean {
  for (let at = text.indexOf(directory); at >= 0; at = text.indexOf(directory, at + 1)) {
    const next = text.charAt(at + directory.length);
    if (next === "" || terminators.includes(next)) return true;
  }
  return false;
}

async function prefixCensus(directory: string, prefix: TeamCommand): Promise<CensusResult> {
  if (!/(^|\/)sudo$/.test(prefix.command)) return { ok: false, problem: "prefix-unsupported" };
  const shape = sudoShape(prefix.args);
  if (!shape.ok || !isAbsolute(shape.executable)) return { ok: false, problem: "prefix-unsupported" };
  const wrapper = join(dirname(shape.executable), CENSUS_WRAPPER);
  try {
    if (!statSync(wrapper).isFile()) return { ok: false, problem: "census wrapper missing" };
  } catch {
    return { ok: false, problem: "census wrapper missing" };
  }
  // -n keeps sudo from waiting for a password; the policy then refuses the census at once if it is not allowed.
  const options = ["-n", ...shape.options.filter(arg => arg !== "-n")];
  return runWrapper(prefix.command, [...options, "--", wrapper], directory);
}

function runWrapper(command: string, args: string[], directory: string): Promise<CensusResult> {
  return new Promise(resolvePromise => {
    let settled = false;
    let output = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CensusResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      finish({ ok: false, problem: "census wrapper could not start" });
      return;
    }
    // The helper child is this census's own sudo process, never the census target.
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
      finish({ ok: false, problem: "census wrapper timed out" });
    }, WRAPPER_LIMIT_MS);
    child.stdin?.on("error", () => { /* The wrapper may exit before reading; its exit status decides. */ });
    child.stdin?.end(`${directory}\n`);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > WRAPPER_OUTPUT_BYTES) {
        try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
        finish({ ok: false, problem: "census wrapper output too large" });
      }
    });
    child.once("error", () => finish({ ok: false, problem: "census wrapper could not start" }));
    child.once("close", code => {
      if (code !== 0) finish({ ok: false, problem: `census wrapper exited ${code ?? "by signal"}` });
      else finish(parseWrapperOutput(output));
    });
  });
}

/** A pseudo-terminal echoes the directory it was sent before the result, so the result is the last line. */
function parseWrapperOutput(text: string): CensusResult {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return { ok: false, problem: "census wrapper printed nothing" };
  let value: unknown;
  try { value = JSON.parse(last); } catch { return { ok: false, problem: "census wrapper printed invalid output" }; }
  return validateWrapperResult(value) ?? { ok: false, problem: "census wrapper printed an invalid result" };
}

/** Strict: the wrapper runs under another account, so its output is checked before it is trusted. */
function validateWrapperResult(value: unknown): CensusResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value.ok === false) {
    if (!hasOnlyKeys(value, ["ok", "problem"]) || typeof value.problem !== "string") return undefined;
    return { ok: false, problem: value.problem.slice(0, 200) };
  }
  if (value.ok !== true || !hasOnlyKeys(value, ["ok", "findings"]) || !Array.isArray(value.findings)) return undefined;
  if (value.findings.length > MAX_WRAPPER_FINDINGS) return undefined;
  const findings: CensusFinding[] = [];
  for (const item of value.findings) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["pid", "reason"])) return undefined;
    const { pid, reason } = item;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    if (typeof reason !== "string" || !REASONS.has(reason)) return undefined;
    findings.push({ pid, reason: reason as CensusReason });
  }
  return { ok: true, findings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function isGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

function problemText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "unknown error";
}

// Command-line entry: the wrapper runs this file with no arguments and the directory on standard input.
const entry = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entry && existsSync(entry) && realpathSync(entry) === fileURLToPath(import.meta.url)) void runCommandLine();

async function runCommandLine(): Promise<void> {
  if (process.argv.length !== 2) {
    process.stderr.write("process-census takes no arguments and reads one directory path on standard input\n");
    process.exitCode = 64;
    return;
  }
  const input = await readInputLine();
  if (input === undefined || input === "" || input.includes("\0") || !isAbsolute(input)) {
    process.stderr.write("process-census needs one absolute directory path on standard input\n");
    process.exitCode = 64;
    return;
  }
  const result = await directoryCensus(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

/** The first line of standard input, at most MAX_INPUT_BYTES. Undefined when the line is longer or the input is empty. */
function readInputLine(): Promise<string | undefined> {
  return new Promise(resolvePromise => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (line: Buffer | undefined) => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
      resolvePromise(line && line.length <= MAX_INPUT_BYTES ? line.toString("utf8") : undefined);
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) finish(buffer.subarray(0, newline));
      else if (buffer.length > MAX_INPUT_BYTES) finish(undefined);
    };
    const onEnd = () => finish(Buffer.concat(chunks));
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}
