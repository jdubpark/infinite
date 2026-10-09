import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { constants } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import type { ControlLease, Session, WorkerState } from "./types.js";
import { nativeCatalogReceiver, NATIVE_COMPRESSION, NATIVE_MAX_BUFFERED, NATIVE_MAX_MESSAGE } from "./native-transport.js";

// Codex accepts only root WebSocket URLs. Keep the scoped cloud URL and device
// key inside Infinite, and give the local TUI a short-lived loopback credential.
async function nativeRelay(url: URL, deviceToken: string, signal: AbortSignal) {
  const token = randomBytes(32).toString("hex");
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: NATIVE_MAX_MESSAGE, perMessageDeflate: false });
  const upstream = new WebSocket(url, { headers: { Authorization: `Bearer ${deviceToken}` }, maxPayload: NATIVE_MAX_MESSAGE, perMessageDeflate: NATIVE_COMPRESSION, handshakeTimeout: 15000 });
  let frontend: WebSocket | undefined, reason: string | undefined;
  let closed = false, localClosed = false, bytes = 0;
  const queue: string[] = [];
  const close = () => {
    if (closed) return;
    closed = true; signal.removeEventListener("abort", close);
    frontend?.terminate(); upstream.terminate(); sockets.close(); server.close();
  };
  const fail = (message: string) => { if (!closed && !localClosed) reason ??= message; close(); };
  const send = (to: WebSocket, text: string) => {
    if (to.readyState !== WebSocket.OPEN) throw new Error("Disconnected");
    if (to.bufferedAmount + Buffer.byteLength(text) > NATIVE_MAX_BUFFERED) throw new Error("Slow native connection");
    to.send(text);
  };
  const deliver = (text: string) => {
    if (frontend) send(frontend, text);
    else { bytes += Buffer.byteLength(text); if (bytes > NATIVE_MAX_BUFFERED) throw new Error("Native queue is full"); queue.push(text); }
  };
  const receiveCatalog = nativeCatalogReceiver(upstream, deliver);
  upstream.on("message", (data, binary) => {
    try { if (binary) receiveCatalog(Buffer.from(data as Buffer)); else deliver(data.toString()); }
    catch { fail("Cloud protocol delivery failed."); }
  });
  upstream.on("error", () => fail("Cloud connection failed or timed out."));
  upstream.on("close", code => fail(`Cloud connection closed (WebSocket ${code}).`));
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const auth = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (closed || frontend || req.url !== "/" || req.headers.origin || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    sockets.handleUpgrade(req, socket, head, client => {
      frontend = client;
      client.on("message", (data, binary) => {
        try { if (binary) throw new Error("Invalid native frame"); send(upstream, data.toString()); }
        catch { fail("Local Codex protocol delivery failed."); }
      });
      client.on("close", () => { localClosed = true; upstream.close(); });
      client.on("error", () => fail("Local Codex connection failed."));
      try { for (const text of queue) send(client, text); queue.length = 0; bytes = 0; }
      catch { fail("Local Codex protocol delivery failed."); }
    });
  });
  try {
    // Codex starts a short initialize deadline after its loopback connection opens.
    // Finish the cloud handshake before launching it so that deadline only covers RPC.
    const connected = new Promise<void>((resolve, reject) => {
      upstream.once("open", resolve);
      upstream.once("error", () => reject(new Error("Cloud connection failed or timed out.")));
      upstream.once("close", () => reject(new Error("Cloud connection closed during startup.")));
    });
    signal.addEventListener("abort", close, { once: true });
    await Promise.all([connected, new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
    })]);
    if (signal.aborted || closed) throw new Error("Local attachment cancelled.");
    return { url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, token, close, failure: () => reason };
  } catch (error) { close(); throw error; }
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
  const current = await request<Pick<WorkerState, "execution">>(`/sessions/${session.id}`);
  const { control } = await request<{ control: ControlLease }>(`/sessions/${session.id}/control`, { action: "claim", ...(takeover ? { takeover: true } : {}) });
  const url = new URL(`/api/sessions/${session.id}/native`, config.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("client", clientId); url.searchParams.set("lease", control.id);
  url.searchParams.set("catalogChunks", "1");
  const abort = new AbortController();
  let relay: Awaited<ReturnType<typeof nativeRelay>> | undefined;
  let child: ReturnType<typeof spawn> | undefined, ttyMode: string | undefined;
  let renewing = false, ended = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined, detachReason: string | undefined, exitReason: string | undefined;
  const detached = () => {
    if (ended || abort.signal.aborted) return;
    // Cut off the provider protocol first: graceful TUI cleanup cannot interrupt
    // a cloud turn after detachment. SIGTERM also lets CLI launchers forward it.
    abort.abort(); relay?.close(); child?.kill("SIGTERM");
    if (child) killTimer = setTimeout(() => child?.kill("SIGKILL"), 2000);
  };
  process.on("SIGHUP", detached); process.on("SIGTERM", detached); process.on("SIGINT", detached);
  // Renewal covers the cloud handshake as well as the visible native interface.
  const timer = setInterval(() => {
    if (renewing || ended) return;
    renewing = true;
    void request(`/sessions/${session.id}/control`, { action: "renew", leaseId: control.id })
      .catch(() => { detachReason = "Control could not be renewed. The local interface detached; check the session before reopening with infinite resume."; detached(); })
      .finally(() => { renewing = false; });
  }, 10000);
  try {
    relay = await nativeRelay(url, config.token, abort.signal);
    ttyMode = spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8", timeout: 2000 }).stdout?.trim();
    const execution = current.execution;
    const status = execution ? `${execution.location} tools · ${execution.state}${execution.checkpoint ? ` · checkpoint ${Math.max(0, Math.floor((Date.now() - Date.parse(execution.checkpoint.capturedAt)) / 1000))}s old` : ""}` : "cloud execution";
    console.error(`[Infinite] Local native UI · ${status} · session ${session.id}\n[Infinite] Exiting this interface leaves the session available. Use infinite monitor to watch it.`);
    child = spawn("codex", ["--remote", relay.url, "--remote-auth-token-env", "INFINITE_NATIVE_TOKEN", ...(info.noAltScreen === true ? ["--no-alt-screen"] : []), "resume", info.sessionId], {
      stdio: "inherit", env: { ...process.env, INFINITE_NATIVE_TOKEN: relay.token },
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once("error", reject); child!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const failure = relay.failure();
    process.exitCode = result.code ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
    if (failure || detachReason) process.exitCode ||= 1;
    if (!abort.signal.aborted) exitReason = failure ?? (result.signal ? `Local Codex exited on ${result.signal}.` : `Local Codex exited with code ${result.code}.`);
  } catch (error) {
    if (!abort.signal.aborted) throw error;
    process.exitCode = 1;
  } finally {
    ended = true; clearInterval(timer); clearTimeout(killTimer); process.off("SIGHUP", detached); process.off("SIGTERM", detached); process.off("SIGINT", detached);
    relay?.close();
    if (child) {
      if (ttyMode) spawnSync("stty", [ttyMode], { stdio: ["inherit", "ignore", "ignore"], timeout: 2000 });
      // stty restores line discipline, not emulator modes. A crashed or disconnected
      // provider may leave mouse/focus reports flowing into the shell as keystrokes.
      process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b[?25h\x1b[?1049l\x1b[0m");
    }
    if (detachReason) console.error(`\n[Infinite] ${detachReason}`);
    else if (exitReason) console.error(`\n[Infinite] ${exitReason} The cloud session remains available. Use infinite resume ${session.id.slice(0, 8)} to reconnect.`);
    await request(`/sessions/${session.id}/control`, { action: "release", leaseId: control.id }).catch(() => {});
  }
}
