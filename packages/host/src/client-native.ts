import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import type { ControlLease, Session } from "./types.js";

// Codex accepts only root WebSocket URLs. Keep the scoped cloud URL and device
// key inside Infinite, and give the local TUI a short-lived loopback credential.
async function nativeRelay(url: URL, deviceToken: string) {
  const token = randomBytes(32).toString("hex");
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });
  const upstreams = new Set<WebSocket>();
  let closed = false;
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const auth = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.url !== "/" || req.headers.origin || sockets.clients.size || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    sockets.handleUpgrade(req, socket, head, frontend => {
      const upstream = new WebSocket(url, { headers: { Authorization: `Bearer ${deviceToken}` }, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 15000 });
      upstreams.add(upstream);
      const queue: string[] = []; let bytes = 0;
      const close = () => { frontend.terminate(); upstream.terminate(); };
      const send = (to: WebSocket, text: string) => {
        if (to.bufferedAmount + Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("Slow native connection");
        to.send(text);
      };
      frontend.on("message", (data, binary) => {
        try {
          if (binary) throw new Error("Invalid native frame");
          const text = data.toString();
          if (upstream.readyState === WebSocket.OPEN) send(upstream, text);
          else if (upstream.readyState === WebSocket.CONNECTING) { bytes += Buffer.byteLength(text); if (bytes > 256 * 1024) throw new Error("Native queue is full"); queue.push(text); }
          else close();
        } catch { close(); }
      });
      upstream.on("open", () => { try { for (const text of queue) send(upstream, text); queue.length = 0; bytes = 0; } catch { close(); } });
      upstream.on("message", (data, binary) => { try { if (binary || frontend.readyState !== WebSocket.OPEN) throw new Error("Disconnected"); send(frontend, data.toString()); } catch { close(); } });
      frontend.on("close", () => upstream.close());
      upstream.on("close", () => { upstreams.delete(upstream); frontend.close(); });
      frontend.on("error", close); upstream.on("error", close);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, token,
    close: () => { if (closed) return; closed = true; for (const socket of [...sockets.clients, ...upstreams]) socket.terminate(); sockets.close(); server.close(); },
  };
}

let checked = false;
export async function checkNativeCodex() {
  if (checked) return;
  try {
    const { stdout } = await promisify(execFile)("codex", ["--help"], { timeout: 5000, maxBuffer: 65536 });
    if (!stdout.includes("--remote-auth-token-env")) throw new Error("Unsupported version");
    checked = true;
  } catch { throw new Error("Install a local Codex CLI with --remote support before using --local-ui. The cloud session was not changed."); }
}

export async function attachNativeCodex(config: { origin: string; token: string }, session: Session, takeover = false) {
  await checkNativeCodex();
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The local native UI needs an interactive terminal. Use --detach or monitor for noninteractive access.");
  const clientId = randomUUID();
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(config.origin + "/api" + path, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${config.token}`, "X-Infinite-Client": clientId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Native attachment refused (HTTP ${response.status}). Inspect the session before retrying; use --takeover to explicitly take control.`); }
    return response.json() as Promise<T>;
  };
  console.error("[Infinite] Connecting the local Codex interface to the existing cloud conversation…");
  let info: { provider: string; sessionId?: string; noAltScreen?: boolean } | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    info = await request(`/sessions/${session.id}/native`);
    if (info?.sessionId) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (info?.provider !== "codex" || !info.sessionId) throw new Error("The cloud conversation is not ready. Use infinite monitor to inspect its startup; resuming will not create another session.");
  const { control } = await request<{ control: ControlLease }>(`/sessions/${session.id}/control`, { action: "claim", ...(takeover ? { takeover: true } : {}) });
  const url = new URL(`/api/sessions/${session.id}/native`, config.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("client", clientId); url.searchParams.set("lease", control.id);
  const relay = await nativeRelay(url, config.token);
  const ttyMode = spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8", timeout: 2000 }).stdout?.trim();
  console.error(`[Infinite] Local native UI · cloud execution · session ${session.id}\n[Infinite] Exiting this interface leaves the cloud session available. Use infinite monitor to watch it.`);
  const child = spawn("codex", ["--remote", relay.url, "--remote-auth-token-env", "INFINITE_NATIVE_TOKEN", ...(info.noAltScreen === true ? ["--no-alt-screen"] : []), "resume", info.sessionId], {
    stdio: "inherit", env: { ...process.env, INFINITE_NATIVE_TOKEN: relay.token },
  });
  let renewing = false, ended = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined, detachReason: string | undefined;
  const detached = () => {
    if (ended) return;
    // Cut off the provider protocol first: graceful TUI cleanup cannot interrupt
    // a cloud turn after detachment. SIGTERM also lets CLI launchers forward it.
    relay.close(); child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
  };
  process.on("SIGHUP", detached); process.on("SIGTERM", detached); process.on("SIGINT", detached);
  const timer = setInterval(() => {
    if (renewing || ended) return;
    renewing = true;
    void request(`/sessions/${session.id}/control`, { action: "renew", leaseId: control.id })
      .catch(() => { detachReason = "Control could not be renewed. The local interface detached; cloud execution continues. Reopen with infinite resume after checking the session."; detached(); })
      .finally(() => { renewing = false; });
  }, 10000);
  try {
    const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 0)); });
    process.exitCode = code;
  } finally {
    ended = true; clearInterval(timer); clearTimeout(killTimer); process.off("SIGHUP", detached); process.off("SIGTERM", detached); process.off("SIGINT", detached);
    relay.close();
    if (ttyMode) spawnSync("stty", [ttyMode], { stdio: ["inherit", "ignore", "ignore"], timeout: 2000 });
    if (killTimer) process.stdout.write("\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[0m");
    if (detachReason) console.error(`\n[Infinite] ${detachReason}`);
    await request(`/sessions/${session.id}/control`, { action: "release", leaseId: control.id }).catch(() => {});
  }
}
