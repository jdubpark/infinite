import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type OpenCodeMajor = 1 | 2;

export interface OpenCodeLaunch { command: string; prefix: readonly string[] }

export interface OpenCodeRead {
  major: OpenCodeMajor;
  version?: string;
  known: boolean;
  note?: string;
}

const TIMEOUT_MS = 5_000;
const MAX_OUTPUT = 4_096;
const CACHE_MS = 60_000;
const ENV_NAMES = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"];

interface Entry { at: number; signature: string; read: Promise<OpenCodeRead> }

const cache = new Map<string, Entry>();
const reported = new Map<string, string>();

export function openCodeModelArg(model: string, variant: string | undefined, major: OpenCodeMajor): string {
  return major === 2 && variant ? `${model}#${variant}` : model;
}

export function parseOpenCodeVersion(output: string): { version: string; major: number } | undefined {
  const match = /(?:^|[^\w.])v?((\d{1,4})\.\d{1,5}\.\d{1,5}(?:[-+][0-9A-Za-z.-]{0,40})?)(?![\w.])/.exec(output.slice(0, MAX_OUTPUT));
  return match ? { version: match[1], major: Number(match[2]) } : undefined;
}

function executableSignature(launch: OpenCodeLaunch): string {
  const path = [launch.command, ...launch.prefix].filter(isAbsolute).at(-1);
  if (!path) return "";
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch { return ""; }
}

function probe(launch: OpenCodeLaunch): Promise<OpenCodeRead> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ENV_NAMES) if (process.env[name]) env[name] = process.env[name];
  const fallback = (note: string): OpenCodeRead => ({ major: 1, known: false, note });
  return new Promise(resolve => {
    try {
      execFile(launch.command, [...launch.prefix, "--version"], { env, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: "utf8", windowsHide: true }, (error, stdout) => {
        if (error) return resolve(fallback(`could not read the version (${(error as NodeJS.ErrnoException).code ?? error.name})`));
        const parsed = parseOpenCodeVersion(String(stdout));
        if (!parsed) return resolve(fallback("the version output was not recognised"));
        if (parsed.major === 1) return resolve({ major: 1, version: parsed.version, known: true });
        if (parsed.major === 2) return resolve({ major: 2, version: parsed.version, known: true });
        resolve({ ...fallback(`OpenCode ${parsed.version} is not a supported major version`), version: parsed.version });
      });
    } catch {
      resolve(fallback("could not start the executable"));
    }
  });
}

export function describeOpenCodeRead(read: OpenCodeRead): string {
  if (read.known) return `OpenCode ${read.version}: using the OpenCode ${read.major} launch form`;
  return `OpenCode version unknown (${read.note}): using the OpenCode 1 launch form`;
}

export async function readOpenCodeVersion(launch: OpenCodeLaunch | undefined): Promise<OpenCodeRead> {
  if (!launch) return { major: 1, known: false, note: "the profile does not launch an opencode executable" };
  const key = JSON.stringify([launch.command, launch.prefix]);
  const signature = executableSignature(launch);
  const now = Date.now();
  let entry = cache.get(key);
  if (!entry || entry.signature !== signature || now - entry.at > CACHE_MS) {
    entry = { at: now, signature, read: probe(launch) };
    cache.set(key, entry);
  }
  const read = await entry.read;
  const line = describeOpenCodeRead(read);
  if (reported.get(key) !== line) {
    reported.set(key, line);
    process.stderr.write(`[Infinite] ${line}\n`);
  }
  return read;
}
