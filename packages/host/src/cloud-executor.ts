import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";

const STARTUP_TIMEOUT = 15000;
const STARTUP_ERROR = "The cloud executor did not become ready. No command was replayed.";

// The parent's pipe bounds the helper lifetime, including parent termination.
// Process-group cleanup is not a fence for detached tool descendants or effects.
const SUPERVISOR = `
  const {spawn}=require('node:child_process');
  const child=spawn(process.argv[1],process.argv.slice(2),{detached:true,stdio:['ignore','pipe','pipe']});
  let stopping=false;
  const kill=signal=>{if(child.pid)try{process.kill(-child.pid,signal)}catch{}};
  const stop=()=>{if(stopping)return;stopping=true;kill('SIGTERM');setTimeout(()=>{kill('SIGKILL');process.exit(1)},2000)};
  process.on('exit',()=>kill('SIGKILL'));
  process.stdout.on('error',stop);process.stderr.on('error',stop);
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  process.stdin.resume();process.stdin.on('end',stop);process.stdin.on('error',stop);
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,stop);
  child.on('error',()=>process.exit(1));
  child.on('exit',code=>{kill('SIGKILL');process.exit(code??1)});
`;

function endpoint(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let done = false;
    const buffers = ["", ""];
    const timer = setTimeout(() => finish(), STARTUP_TIMEOUT);
    const finish = (url?: string) => {
      if (done) return;
      done = true; clearTimeout(timer);
      child.off("error", failed); child.off("exit", failed);
      child.stdout?.off("data", stdout); child.stderr?.off("data", stderr);
      child.stdout?.resume(); child.stderr?.resume();
      if (url) resolve(url); else reject(new Error(STARTUP_ERROR));
    };
    const failed = () => finish();
    const read = (index: number, data: Buffer) => {
      buffers[index] = (buffers[index] + data.toString()).slice(-16384);
      const match = /(?:^|\s)ws:\/\/127\.0\.0\.1:(\d+)(?:\/)?(?=[\s"'])/.exec(buffers[index]);
      if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535)
        finish(`ws://127.0.0.1:${match[1]}`);
    };
    const stdout = (data: Buffer) => read(0, data);
    const stderr = (data: Buffer) => read(1, data);
    child.on("error", failed); child.on("exit", failed);
    child.stdout?.on("data", stdout); child.stderr?.on("data", stderr);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

/** Start a private executor against an already materialized cloud workspace. */
export async function startCloudExecutor(options: { cwd: string; command?: string; commandArgs?: string[] }): Promise<{
  environment: { environmentId: string; url: string; token: string; cwd: string };
  exited: Promise<void>;
  close(): Promise<void>;
}> {
  let cwd: string;
  try {
    cwd = await realpath(options.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("Not a directory");
  } catch { throw new Error("The materialized cloud working directory is unavailable."); }
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, ["-e", SUPERVISOR, options.command ?? "codex", ...(options.commandArgs ?? []), "exec-server",
    "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token",
    "--ws-token-sha256", createHash("sha256").update(token).digest("hex")], {
    cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
  });
  let closed = false, closing: Promise<void> | undefined;
  const exited = new Promise<void>(resolve => child.once("close", () => { closed = true; resolve(); }));
  // Errors must remain handled after the startup listeners have been removed.
  child.on("error", () => {});
  child.stdin.on("error", () => { child.kill("SIGTERM"); });
  const close = (): Promise<void> => closing ??= (async () => {
    if (closed) return;
    child.stdin.destroy(); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3500);
    try { await exited; } finally { clearTimeout(timer); }
  })();
  try {
    const url = await endpoint(child);
    return { environment: { environmentId: `infinite-cloud-${randomUUID()}`, url, token, cwd }, exited, close };
  } catch (error) { await close(); throw error; }
}
