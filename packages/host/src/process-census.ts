import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sudoShape } from "./sudo-profile.js";
import type { TeamCommand } from "./team-types.js";

export interface ProcessRow {
  pid: number; ppid: number; pgid: number;
  sid?: number;
  uid: number;
  start: string;
  command: string;
}
export interface ProcessTable {
  boot: string;
  rows: ProcessRow[];
}
export interface ProcessWitness {
  boot: string;
  processes: { pid: number; start: string }[];
  sessions: number[];
  groups: number[];
  overflow?: true;
}
export type CensusReason = "recorded-process" | "recorded-session" | "recorded-group" | "working-directory" | "open-file" | "command-line" | "unreadable";
export interface CensusFinding { pid: number; reason: CensusReason }
export type CensusResult = { ok: true; findings: CensusFinding[] } | { ok: false; problem: string };

export const CENSUS_WRAPPER = "process-census";
export const WITNESS_LIMIT = 4096;

const REASONS = new Set<string>(["recorded-process", "recorded-session", "recorded-group", "working-directory", "open-file", "command-line", "unreadable"]);
const PS = "/bin/ps";
const LSOF = "/usr/sbin/lsof";
const EXEC_LIMIT_MS = 20_000;
const TABLE_BUFFER_BYTES = 64 * 1024 * 1024;
const WRAPPER_LIMIT_MS = 10_000;
const SECOND_PASS_MS = 100;
const LOOK_AGAIN_MS = 100;
const WRAPPER_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_WRAPPER_FINDINGS = 10_000;
const MAX_INPUT_BYTES = 4096;

let boot: string | undefined;
export function bootId(): string {
  if (boot !== undefined) return boot;
  try {
    if (process.platform === "linux") boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    else if (process.platform === "darwin") boot = /sec = (\d+)/.exec(execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5000 }))?.[1];
  } catch {}
  return boot ||= "unsupported";
}
export function newWitness(): ProcessWitness {
  return { boot: bootId(), processes: [], sessions: [], groups: [] };
}
export async function readProcessTable(): Promise<ProcessTable> {
  const id = bootId();
  if (id === "unsupported") throw new Error("the boot cannot be named");
  if (process.platform === "linux") return { boot: id, rows: await linuxRows() };
  if (process.platform === "darwin") return { boot: id, rows: await darwinRows() };
  throw new Error(`unsupported platform: ${process.platform}`);
}
export async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try { return parseLinuxStat(await readFile(`/proc/${pid}/stat`, "utf8")).start; } catch (error) { if (isGone(error)) return undefined; throw error; }
  }
  if (process.platform === "darwin") {
    try { return (await run(PS, ["-p", String(pid), "-o", "lstart="])).trim() || undefined; } catch (error) { if ((error as { code?: unknown }).code === 1) return undefined; throw error; }
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}
export function recordCommand(witness: ProcessWitness, pid: number, start?: string): boolean {
  let changed = addUnique(witness, witness.groups, pid);
  changed = addUnique(witness, witness.sessions, pid) || changed;
  if (start === undefined || witness.processes.some(recorded => recorded.pid === pid && recorded.start === start)) return changed;
  if (witness.processes.length >= WITNESS_LIMIT) return markOverflow(witness) || changed;
  witness.processes.push({ pid, start });
  return true;
}
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
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]), pgid = Number(fields[2]), sid = Number(fields[3]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid) || !Number.isInteger(sid) || !fields[19]) throw new Error("unreadable process stat");
  return { ppid, pgid, sid, start: fields[19] };
}

async function linuxRows(): Promise<ProcessRow[]> {
  const rows: ProcessRow[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const row = await linuxRow(Number(entry));
    if (row) rows.push(row);
  }
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
  if (!findings.some(finding => finding.reason === "unreadable")) return findings;
  await new Promise(resolvePromise => setTimeout(resolvePromise, LOOK_AGAIN_MS));
  const decided: CensusFinding[] = [];
  for (const finding of findings) {
    const reason = finding.reason === "unreadable" ? await linuxReason(finding.pid, uid, directory) : finding.reason;
    if (reason) decided.push({ pid: finding.pid, reason });
  }
  return decided;
}

async function linuxReason(pid: number, uid: number, directory: string): Promise<CensusReason | undefined> {
  const base = `/proc/${pid}`;
  try {
    if ((await stat(base)).uid !== uid) return await linuxRunsAs(base, uid) ? "unreadable" : undefined;
  } catch (error) {
    return isGone(error) ? undefined : "unreadable";
  }
  const view = await linuxLinks(base);
  if (view.missing) {
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

async function linuxLinks(base: string): Promise<{ paths: { reason: "working-directory" | "open-file"; path: string }[]; missing: boolean; unreadable: boolean }> {
  const paths: { reason: "working-directory" | "open-file"; path: string }[] = [];
  let missing = false;
  let refused = false;
  try {
    for (const fd of await readdir(`${base}/fd`)) {
      try { paths.push({ reason: "open-file", path: withoutDeleted(await readlink(`${base}/fd/${fd}`)) }); } catch (error) { if (!isGone(error)) refused = true; }
    }
  } catch (error) {
    if (isGone(error)) missing = true; else refused = true;
  }
  try {
    paths.push({ reason: "working-directory", path: withoutDeleted(await readlink(`${base}/cwd`)) });
  } catch (error) {
    return isGone(error) ? { paths, missing: true, unreadable: false } : { paths, missing, unreadable: true };
  }
  return { paths, missing, unreadable: refused };
}

async function linuxRunsAs(base: string, uid: number): Promise<boolean> {
  try {
    return statusRunsAs(await readFile(`${base}/status`, "utf8"), uid);
  } catch (error) {
    return !isGone(error);
  }
}

export function statusRunsAs(status: string, uid: number): boolean {
  const ids = status.split("\n").find(line => line.startsWith("Uid:"))?.trim().split(/\s+/).slice(1).map(Number) ?? [];
  if (ids.length !== 4 || ids.some(id => !Number.isInteger(id))) return true;
  return ids.slice(1).includes(uid);
}

async function darwinCensus(directory: string): Promise<CensusFinding[]> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("the user id cannot be read");
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

function isCensusHelper(row: ProcessRow): boolean {
  return row.ppid === process.pid && /^(\/bin\/ps|\/usr\/sbin\/lsof)( |$)/.test(row.command);
}

async function stillSameProcess(row: ProcessRow): Promise<boolean> {
  try { return (await processStart(row.pid)) === row.start; } catch { return true; }
}

async function lsofRecords(uid: number): Promise<Map<number, { cwd?: string; files: string[] }>> {
  const { stdout, error } = await exec(LSOF, ["-a", "-u", String(uid), "-Fpfn"]);
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
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ ok: false, problem: "census wrapper timed out" });
    }, WRAPPER_LIMIT_MS);
    child.stdin?.on("error", () => {});
    child.stdin?.end(`${directory}\n`);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > WRAPPER_OUTPUT_BYTES) {
        try { child.kill("SIGKILL"); } catch {}
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

function parseWrapperOutput(text: string): CensusResult {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return { ok: false, problem: "census wrapper printed nothing" };
  let value: unknown;
  try { value = JSON.parse(last); } catch { return { ok: false, problem: "census wrapper printed invalid output" }; }
  return validateWrapperResult(value) ?? { ok: false, problem: "census wrapper printed an invalid result" };
}

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
