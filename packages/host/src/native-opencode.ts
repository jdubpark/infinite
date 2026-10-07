import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { Signal } from "@infinite/attention";
import type { AgentProfile, InputControl } from "./types.js";
import { nativeEvents, readNativeBody, readNativeResponse } from "./native-http.js";

export function validateNativeOpenCodeArgs(args: string[], initialPrompt = "") {
  const result: { prompt: string; model?: string; agent?: string; pure: boolean } = { prompt: initialPrompt, pure: false };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2);
    if (flag === "--pure" && inline === undefined) { result.pure = true; continue; }
    if (!["--model", "-m", "--agent", "--prompt"].includes(flag)) throw new Error("Local OpenCode UI supports --model, --agent, --prompt and --pure. Use terminal mode for other native arguments.");
    const value = inline ?? args[++i];
    if (!value?.trim()) throw new Error(`Missing value for ${flag}`);
    if (flag === "--model" || flag === "-m") { if (!/^[^/\s]+\/.+/.test(value)) throw new Error("OpenCode models use provider/model"); result.model = value; }
    else if (flag === "--agent") result.agent = value;
    else result.prompt = value;
  }
  return result;
}

export async function startNativeOpenCode(options: {
  profile: AgentProfile; cwd: string; env: Record<string, string>; title: string;
  settings: ReturnType<typeof validateNativeOpenCodeArgs>;
  checkControl: (authority: InputControl) => void;
  onThread: (id: string) => void; onExit: () => void;
  onSignal: (signal: Signal) => number | undefined; record: (method: string) => void;
}) {
  const password = randomBytes(32).toString("hex"), observerToken = randomBytes(32).toString("hex");
  const basic = (token: string) => `Basic ${Buffer.from(`infinite:${token}`).toString("base64")}`;
  const attachments = new Map<string, InputControl>(), active = new Set<ServerResponse>();
  const abort = new AbortController();
  let child: ChildProcess | undefined, endpoint = "", sessionId = "", stopped = false;
  let working = false, failed = false, lastMessage: string | undefined;
  const roles = new Map<string, string>();
  const prompts = new Map<string, number>();
  const server = createServer();
  const stop = () => {
    if (stopped) return; stopped = true; abort.abort();
    for (const response of active) response.destroy();
    server.closeAllConnections(); server.close(); child?.kill("SIGTERM"); attachments.clear();
  };
  const call = async (path: string, init?: RequestInit) => {
    const url = new URL(path, endpoint); url.searchParams.set("directory", options.cwd); url.searchParams.delete("workspace");
    return fetch(url, { ...init, redirect: "error", headers: { Authorization: basic(password), "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(options.cwd) }, signal: init?.signal ?? abort.signal });
  };
  const belongs = (event: any) => {
    const payload = event.payload ?? event;
    const p = payload.properties ?? {};
    const id = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? (payload.type?.startsWith("session.") ? p.info?.id : undefined);
    return id === undefined || id === sessionId;
  };
  const signal = (event: any) => {
    if (!belongs(event)) return;
    const { type, properties: p = {} } = event.payload ?? event;
    if (type === "session.status" && p.sessionID === sessionId) {
      if (p.status?.type === "busy" && !working) { working = true; failed = false; lastMessage = undefined; options.onSignal({ kind: "turn-start" }); }
      if (p.status?.type === "idle" && working) { working = false; options.onSignal({ kind: "turn-end", message: lastMessage, failed }); }
    }
    if (type === "message.updated" && p.info?.sessionID === sessionId) {
      roles.set(p.info.id, p.info.role); if (roles.size > 256) roles.delete(roles.keys().next().value!);
    }
    if (type === "message.part.updated" && p.part?.type === "text" && roles.get(p.part.messageID) === "assistant") lastMessage = p.part.text?.slice(0, 4000);
    if (["permission.asked", "question.asked"].includes(type) && p.sessionID === sessionId && typeof p.id === "string" && !prompts.has(p.id)) {
      const permission = type === "permission.asked";
      const id = options.onSignal({ kind: "prompt-open", prompt: {
        id: 0, kind: permission ? "permission" : "question", source: "protocol",
        title: permission ? "OpenCode permission required" : "OpenCode has a question",
        detail: `${String(permission ? p.permission ?? "" : p.questions?.[0]?.question ?? "").slice(0, 1600)}\nUse the native terminal controls to answer the current dialog.`,
        // The provider's actual dialog owns the choices. Do not manufacture
        // compact approval buttons from an unverified screen mapping.
        options: [], acceptsText: false, multiSelect: false,
      } });
      if (id !== undefined) { prompts.set(p.id, id); if (prompts.size > 256) prompts.delete(prompts.keys().next().value!); }
    }
    if (["permission.replied", "question.replied", "question.rejected"].includes(type) && p.sessionID === sessionId) {
      const id = prompts.get(p.requestID);
      if (id !== undefined) { prompts.delete(p.requestID); options.onSignal({ kind: "prompt-closed", promptId: id, reason: "resolved" }); }
    }
    if (type === "session.error" && p.sessionID === sessionId) { failed = true; options.onSignal({ kind: "error", where: "provider", message: "OpenCode reported a session error. Inspect the native interface." }); }
  };
  try {
    child = spawn(options.profile.command, [...options.profile.args, ...(options.settings.pure ? ["--pure"] : []), "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: options.cwd, env: { ...options.env, OPENCODE_SERVER_USERNAME: "infinite", OPENCODE_SERVER_PASSWORD: password,
        ...((options.settings.model || options.settings.agent) ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...(options.settings.model ? { model: options.settings.model } : {}), ...(options.settings.agent ? { default_agent: options.settings.agent } : {}) }) } : {}),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("exit", () => { if (!stopped) { stop(); options.onExit(); } });
    endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => finish(new Error("OpenCode server did not become ready")), 30000);
      const finish = (error?: Error, url?: string) => { clearTimeout(timer); child!.stdout!.off("data", read); child!.stderr!.off("data", read); child!.off("error", errorHandler); child!.off("exit", exitHandler); error ? reject(error) : resolve(url!); };
      const read = (data: Buffer) => { output = (output + data.toString()).slice(-16384); const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output); if (match) finish(undefined, match[1]); };
      const errorHandler = () => finish(new Error("Could not launch OpenCode server")), exitHandler = () => finish(new Error("OpenCode server exited during startup"));
      child!.stdout!.on("data", read); child!.stderr!.on("data", read); child!.once("error", errorHandler); child!.once("exit", exitHandler);
    });
    child.stdout!.resume(); child.stderr!.resume();
    const created = await call("/session", { method: "POST", body: JSON.stringify({ title: options.title }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]) });
    if (!created.ok) throw new Error("OpenCode could not create a conversation");
    const session = await created.json() as { id: string };
    if (!/^ses_[a-zA-Z0-9]+$/.test(session.id)) throw new Error("OpenCode returned an unsupported conversation identity");
    sessionId = session.id; options.onThread(sessionId);
    const events = await call("/event");
    if (!events.ok) throw new Error("OpenCode events unavailable");
    void (async () => {
      try { for await (const event of nativeEvents(events)) signal(event); }
      catch { if (!stopped) options.onSignal({ kind: "error", where: "provider", message: "OpenCode event stream was lost. Status may be stale; inspect the session." }); }
    })();
    server.on("request", async (req, res) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      const requestAbort = new AbortController();
      const cleanup = () => { clearInterval(timer); active.delete(res); requestAbort.abort(); };
      res.on("close", cleanup);
      try {
        const authorization = req.headers.authorization ?? "";
        const observer = authorization === basic(observerToken);
        const authority = attachments.get(authorization);
        attachments.delete(authorization);
        if (req.headers.origin || (!observer && !authority) || active.size >= 64) throw new Error("Denied");
        const check = () => { if (!observer) options.checkControl(authority!); };
        check(); active.add(res);
        timer = setInterval(() => { try { check(); } catch { res.destroy(); } }, 1000);
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (/%2f|%5c|%2e|\\/i.test(url.pathname)) throw new Error("Invalid native path");
        const path = url.pathname, method = req.method ?? "GET";
        const match = /^\/session\/([^/]+)(.*)$/.exec(path);
        if (match && match[1] !== "status" && match[1] !== sessionId) throw new Error("This interface is pinned to one conversation");
        if (match && (/\/(fork|share|children)/.test(match[2]) || method === "DELETE")) throw new Error("Manage conversations through Infinite");
        const reply = /^\/(permission|question)\/([^/]+)\/(reply|reject)$/.exec(path);
        if (method !== "GET") {
          const sessionWrite = match?.[1] === sessionId && ((method === "PATCH" && match[2] === "") || (method === "POST" && /^\/(message|prompt_async|abort|command|shell|summarize|revert|unrevert)$/.test(match[2])));
          if (!(sessionWrite || (reply && method === "POST") || (path === "/log" && method === "POST"))) throw new Error("Native administration is unavailable in this attachment");
          if (reply) {
            const pending = await call(`/${reply[1]}`, { signal: requestAbort.signal });
            const items = await pending.json() as any[];
            if (!pending.ok || !Array.isArray(items) || !items.some(item => item.id === reply[2] && item.sessionID === sessionId)) throw new Error("Permission or question no longer belongs to this conversation");
          }
        } else if (!match && !/^\/(global\/(health|event)|event|session|permission|question|config(?:\/providers)?|provider(?:\/auth)?|agent|command|path|vcs|lsp|mcp|formatter|skill|project(?:\/current)?|file(?:\/[^/]+)?|find(?:\/[^/]+)?|experimental\/(capabilities|console|resource|workspace)(?:\/[^/]+)?)$/.test(path)) throw new Error("Unsupported native read");
        const body = await readNativeBody(req); check();
        if (body.length) JSON.parse(body.toString());
        if (method !== "GET") options.record(`${method} ${path.replace(sessionId, ":session")}`);
        const response = await call(url.pathname + url.search, { method, ...(body.length ? { body: body.toString() } : {}), signal: requestAbort.signal });
        if (path === "/event" || path === "/global/event") {
          if (!response.ok) throw new Error("Events unavailable");
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" }); res.flushHeaders();
          for await (const event of nativeEvents(response)) if (belongs(event)) {
            check(); if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) await once(res, "drain", { signal: requestAbort.signal });
          }
          res.end();
        } else {
          const text = await readNativeResponse(response); check();
          let data = text ? JSON.parse(text) : undefined;
          if (["/session", "/permission", "/question"].includes(path) && Array.isArray(data)) data = data.filter((item: any) => (path === "/session" ? item.id : item.sessionID) === sessionId);
          if (path === "/session/status" && data) data = data[sessionId] ? { [sessionId]: data[sessionId] } : {};
          res.writeHead(response.status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(data === undefined ? undefined : JSON.stringify(data));
        }
      } catch {
        if (!res.headersSent) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Native request refused. This attachment needs current control and is pinned to one conversation." })); }
        else res.destroy();
      } finally { cleanup(); }
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (options.settings.prompt) {
      const result = await call(`/session/${sessionId}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: options.settings.prompt }] }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]) });
      if (!result.ok) throw new Error("OpenCode did not accept the initial prompt");
      await result.body?.cancel();
    }
    return {
      url, observerToken,
      info: () => ({ provider: "opencode" as const, sessionId, cwd: options.cwd, pure: options.settings.pure }),
      connect(authority: InputControl) {
        options.checkControl(authority);
        for (const [key, value] of attachments) { try { options.checkControl(value); } catch { attachments.delete(key); } }
        if (attachments.size >= 128 || stopped) throw new Error("Native connection unavailable");
        const credential = randomBytes(32).toString("hex"); attachments.set(basic(credential), authority);
        return { url, token: basic(credential), sessionId };
      },
      stop, suspend: () => { child?.kill("SIGSTOP"); },
    };
  } catch (error) { stop(); throw error; }
}
