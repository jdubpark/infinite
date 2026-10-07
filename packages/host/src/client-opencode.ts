import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { constants } from "node:os";
import type { ControlLease, Session } from "./types.js";
import { proxyNativeHttp, readNativeBody } from "./native-http.js";

export async function checkNativeOpenCode() {
  try {
    const { stdout, stderr } = await promisify(execFile)("opencode", ["attach", "--help"], { timeout: 10000, maxBuffer: 65536 });
    const help = stdout + stderr;
    if (!help.includes("--session") || !help.includes("--password")) throw new Error("Unsupported version");
  } catch { throw new Error("Install a local OpenCode CLI with authenticated attach support before using --local-ui. The cloud session was not changed."); }
}

export async function attachNativeOpenCode(config: { origin: string; token: string }, session: Session, takeover = false) {
  await checkNativeOpenCode();
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The local native UI needs an interactive terminal. Use --detach or monitor for noninteractive access.");
  const clientId = randomUUID();
  const headers = { Authorization: `Bearer ${config.token}`, "X-Infinite-Client": clientId };
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(config.origin + "/api" + path, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Native attachment refused (HTTP ${response.status}). Inspect the session before retrying; use --takeover to explicitly take control.`); }
    return response.json() as Promise<T>;
  };
  console.error("[Infinite] Connecting the local OpenCode interface to the existing cloud conversation…");
  const info = await api<{ provider: string; sessionId: string; cwd: string; pure?: boolean }>(`/sessions/${session.id}/native`);
  if (info?.provider !== "opencode" || !/^ses_[a-zA-Z0-9]+$/.test(info.sessionId)) throw new Error("The OpenCode conversation is unavailable. Use infinite monitor to inspect it.");
  const { control } = await api<{ control: ControlLease }>(`/sessions/${session.id}/control`, { action: "claim", ...(takeover ? { takeover: true } : {}) });
  const token = randomBytes(32).toString("hex"), expected = Buffer.from(`Basic ${Buffer.from(`infinite:${token}`).toString("base64")}`);
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || !req.url?.startsWith("/") || req.url.startsWith("//")) { res.writeHead(403); res.end(); return; }
    try {
      const body = await readNativeBody(req);
      const url = new URL(`/api/sessions/${session.id}/opencode${req.url}`, config.origin);
      proxyNativeHttp(req, res, url, { ...headers, "X-Infinite-Control": control.id }, body);
    } catch { res.writeHead(400); res.end(); }
  });
  let child: ReturnType<typeof spawn> | undefined, ttyMode: string | undefined;
  let ended = false, detaching = false, renewing = false, reason: string | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const detach = () => {
    if (ended || detaching) return; detaching = true;
    // Cut off transport before the native UI can send cleanup requests.
    server.closeAllConnections(); server.close(); child?.kill("SIGTERM");
    if (child) killTimer = setTimeout(() => child?.kill("SIGKILL"), 2000);
  };
  process.on("SIGHUP", detach); process.on("SIGINT", detach); process.on("SIGTERM", detach);
  const timer = setInterval(() => {
    if (ended || renewing) return; renewing = true;
    void api(`/sessions/${session.id}/control`, { action: "renew", leaseId: control.id })
      .catch(() => { reason = "Control could not be renewed. The interface detached; cloud execution continues. Reopen with infinite resume after inspecting the session."; detach(); })
      .finally(() => { renewing = false; });
  }, 10000);
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    if (detaching) return;
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ttyMode = spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8", timeout: 2000 }).stdout?.trim();
    console.error(`[Infinite] Local native UI · cloud execution · session ${session.id}\n[Infinite] Exiting this interface leaves the cloud session available.`);
    child = spawn("opencode", [...(info.pure ? ["--pure"] : []), "attach", url, "--session", info.sessionId, "--dir", info.cwd], {
      stdio: "inherit", env: { ...process.env, OPENCODE_SERVER_PASSWORD: token, OPENCODE_SERVER_USERNAME: "infinite" },
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child!.once("error", reject); child!.once("exit", (code, signal) => resolve({ code, signal })); });
    process.exitCode = result.code ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
    if (reason) process.exitCode ||= 1;
  } finally {
    ended = true; clearInterval(timer); clearTimeout(killTimer);
    process.off("SIGHUP", detach); process.off("SIGINT", detach); process.off("SIGTERM", detach);
    server.closeAllConnections(); server.close();
    if (child) {
      if (ttyMode) spawnSync("stty", [ttyMode], { stdio: ["inherit", "ignore", "ignore"], timeout: 2000 });
      process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[?25h\x1b[?1049l\x1b[0m");
    }
    if (reason) console.error(`\n[Infinite] ${reason}`);
    await api(`/sessions/${session.id}/control`, { action: "release", leaseId: control.id }).catch(() => {});
  }
}
