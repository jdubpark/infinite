import express from "express";
import { createServer } from "node:http";
import { connectTerminals, terminalPages } from "./terminal-stream.js";
import { connectNativeFrontends } from "./native-bridge.js";
import { proxyNativeHttp } from "./native-http.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Manager } from "./manager.js";
import { hashToken } from "./config.js";
import { runtimeSecurity } from "./deployment.js";
import { workerCall, type WorkerError } from "./ipc.js";
import { PushStore, isExpoToken } from "./push.js";
import { controlActor, type PairedDevice } from "./device-control.js";
import { machineIdentity } from "./machine.js";
import { CmuxSessions } from "./cmux/index.js";
import { CmuxError } from "./cmux/client.js";
import { ContentError, recordedMessages, sessionFile } from "./session-content.js";
import { connectRemoteAccess } from "./remote-access.js";
import { ProjectSync, ProjectSyncError } from "./project-sync.js";
import type { Config, Role, Receipt } from "./types.js";

const id = z.uuid();
const createSchema = z
  .object({
    requestId: id,
    backend: z.enum(["infinite", "cmux"]).optional(),
    provider: z.enum(["claude", "codex", "grok", "opencode", "demo"]),
    projectId: z.string().max(80),
    title: z.string().trim().min(1).max(100),
    prompt: z.string().max(24000).default(""),
    nativeArgs: z.array(z.string().max(8192).refine((s) => !s.includes("\0")))
      .max(256).refine((args) => args.join("").length <= 32000).optional(),
    localUi: z.boolean().optional(),
    workspace: z.object({
      cwd: z.string().min(1).max(4096).refine(value => value.startsWith("/") && !value.includes("\0")),
      roots: z.array(z.string().min(1).max(4096).refine(value => value.startsWith("/") && !value.includes("\0"))).min(1).max(16),
      token: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().optional(),
  })
  .strict();
const ANSWER_REFUSALS = new Set([
  "prompt-changed",
  "unsupported",
  "invalid-option",
  "text-not-accepted",
]);
const answerSchema = z
  .object({
    requestId: id,
    promptId: z.number().int().min(1),
    option: z.number().int().min(0).max(50).optional(),
    text: z
      .string()
      .min(1)
      .max(32000)
      .regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/)
      .optional(),
  })
  .strict()
  .refine((b) => b.option !== undefined || b.text !== undefined, {
    message: "option or text is required",
  });
const inputSchema = z
  .object({
    requestId: id,
    text: z
      .string()
      .min(1)
      .max(32000)
      .regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/),
    submit: z.boolean().default(true),
    force: z.boolean().optional(),
  })
  .strict();
export function createApp(config: Config, key: Buffer) {
  config.machine = machineIdentity(config, key);
  if ((config.cmux?.enabled || config.remote?.enabled) && runtimeSecurity(config.deployment).tenancy !== "single-tenant")
    throw new Error("Machine access and cmux require a single-tenant host");
  const app = express();
  const manager = new Manager(config, key);
  const projectSync = new ProjectSync(config, key);
  const projectRunning = async (projectId: string) =>
    (await manager.list()).some(s => s.projectId === projectId && ["running", "starting"].includes(s.status) && s.executionLocation !== "laptop");
  const projectSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);
  // Apply snapshots `running` once; a session started mid-apply would write into a tree about to be retired.
  const refusedWhileApplying = (projectId: string, res: express.Response) => {
    if (!projectSync.applying(projectId)) return false;
    res.status(409).json({ code: "sync-applying", error: "A workspace sync is being applied to this project. Start the session after it finishes." });
    return true;
  };
  const cmux = config.cmux?.enabled ? new CmuxSessions(config, key) : undefined;
  const resumable = (session: { status: string; provider: string; workspace?: unknown; nativeSession?: unknown; resumeNativeSession?: unknown }) =>
    session.status === "exited" && !session.workspace && Boolean(session.nativeSession ?? session.resumeNativeSession) && ["claude", "codex", "opencode"].includes(session.provider);
  const listSessions = async () => {
    const native = (await manager.list()).map(session => ({ ...session, backend: "infinite" as const, machineId: config.machine!.id, resumable: resumable(session) }));
    // Provider conversation IDs survive restarts and can exist in several
    // recordings. Only a currently verified worker PID identifies this runtime.
    const known = new Set(native.filter(s => s.status === "running" && s.nativeSession && s.pid)
      .map(s => `${s.provider}:${s.nativeSession!.id}:${s.pid}`));
    const external = cmux ? (await cmux.list()).filter(s => s.status !== "running" || !s.nativeSession || !s.pid || !known.has(`${s.provider}:${s.nativeSession.id}:${s.pid}`)) : [];
    return [...native, ...external.map(s => ({ ...s, backend: "cmux" as const, machineId: config.machine!.id, resumable: resumable(s) }))];
  };
  const pushStore = new PushStore(config.stateDir, key);
  async function inputAuthority(sessionId: string, res: express.Response) {
    // Retained workers from earlier releases hash the entire request. Adding
    // optional fields would make a pre-upgrade receipt impossible to retry.
    return (await manager.state(sessionId)).capabilities?.inputControl
      ? { actor: res.locals.actor, leaseId: res.locals.leaseId } : {};
  }
  const cookies = new Map<string, { device: PairedDevice; expires: number }>();
  const attempts = new Map<string, { start: number; count: number }>();
  const origin = new URL(config.origin);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' wss: ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
    });
    if (req.headers.origin && req.headers.origin !== origin.origin)
      return res.status(403).json({ error: "Origin is not allowed" });
    const allowedHosts = [
      origin.host,
      `127.0.0.1:${config.port}`,
      `localhost:${config.port}`,
    ];
    if (!allowedHosts.includes(req.headers.host ?? ""))
      return res.status(403).json({ error: "Host is not allowed" });
    next();
  });
  app.use((req, res, next) => express.json({ limit: /^\/api\/sessions\/[^/]+\/opencode(?:\/|$)/.test(req.path) ? "8mb"
    : /^\/api\/projects\/[^/]+\/sync\/commit$/.test(req.path) ? "32mb" : "96kb" })(req, res, next));
  function authenticate(token: string) {
    const digest = Buffer.from(hashToken(token), "hex");
    return config.tokens.find((t) =>
      timingSafeEqual(digest, Buffer.from(t.hash, "hex")),
    );
  }
  app.post("/api/login", (req, res) => {
    const ip = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const attempt = attempts.get(ip);
    if (!attempt || now - attempt.start > 60000)
      attempts.set(ip, { start: now, count: 1 });
    else if (++attempt.count > 10)
      return res
        .status(429)
        .json({ error: "Too many attempts. Try again in one minute." });
    if (req.headers.origin !== origin.origin)
      return res
        .status(403)
        .json({ error: "Browser sign-in requires the configured origin" });
    const token = z.string().min(32).max(200).parse(req.body?.token);
    const device = authenticate(token);
    if (!device)
      return res.status(401).json({ error: "Device key was not recognized" });
    for (const [value, session] of cookies)
      if (session.expires <= now) cookies.delete(value);
    if (cookies.size > 64)
      return res.status(429).json({ error: "Too many browser connections" });
    const value = randomBytes(32).toString("base64url");
    cookies.set(hashToken(value), { device, expires: now + 12 * 60 * 60 * 1000 });
    res.cookie("infinite", value, {
      httpOnly: true,
      sameSite: "strict",
      secure: origin.protocol === "https:",
      maxAge: 12 * 60 * 60 * 1000,
      path: "/api",
    });
    return res.json({ role: device.role });
  });
  app.use("/api", (req, res, next) => {
    const bearer =
      req.headers.authorization?.match(/^Bearer (.{32,200})$/)?.[1];
    let device = bearer ? authenticate(bearer) : undefined;
    let instance = "legacy";
    if (!bearer) {
      const value = req.headers.cookie
        ?.split(";")
        .map((v) => v.trim())
        .find((v) => v.startsWith("infinite="))
        ?.slice(9);
      const session = value ? cookies.get(hashToken(value)) : undefined;
      if (session && session.expires > Date.now()) {
        device = session.device;
        instance = hashToken(value!);
      }
      if (req.method !== "GET" && req.headers.origin !== origin.origin)
        return res
          .status(403)
          .json({ error: "Origin is required for browser changes" });
    }
    if (!device)
      return res.status(401).json({ error: "Connect with a device key" });
    res.locals.role = device.role;
    res.locals.deviceId = device.id;
    res.locals.bearer = Boolean(bearer);
    const clientId = req.get("X-Infinite-Client");
    res.locals.actor = controlActor(device, clientId ? id.parse(clientId) : instance);
    res.locals.leaseId = id.optional().parse(req.get("X-Infinite-Control"));
    next();
  });
  const requireRole =
    (roles: Role[]): express.RequestHandler =>
    (_req, res, next) =>
      roles.includes(res.locals.role)
        ? next()
        : void res.status(403).json({
            error: "This device is not allowed to perform that action",
          });
  app.get("/api/me", (_req, res) =>
    res.json({
      role: res.locals.role,
      machine: { ...config.machine, environment: config.environment },
      backends: ["infinite", ...(cmux ? ["cmux"] : [])],
      backendProviders: { infinite: Object.keys(config.agents).filter(p => p !== "demo" || config.enableDemo), cmux: cmux ? ["claude", "codex"].filter(p => p in config.agents) : [] },
      terminal: { stream: true, duplex: true, snapshot: true, control: true, raw: res.locals.role === "owner" },
      nativeUi: ["codex", "opencode"].filter(provider => config.agents[provider as "codex" | "opencode"]),
      execution: { laptop: Boolean(config.agents.codex) && runtimeSecurity(config.deployment).tenancy === "single-tenant", cloudHandoff: Boolean(config.agents.codex) && runtimeSecurity(config.deployment).tenancy === "single-tenant", default: "cloud" as const },
      environment: config.environment,
      security: runtimeSecurity(config.deployment),
      providers: Object.keys(config.agents).filter(
        (p) => p !== "demo" || config.enableDemo,
      ),
      projects: config.projects.map(({ id, name }) => ({ id, name })),
      capabilities: {
        signals: true,
        answer: ["owner", "controller"].includes(res.locals.role),
        push: Boolean(config.push?.enabled),
      },
    }),
  );
  app.post("/api/devices/push", (req, res) => {
    const body = z
      .object({
        token: z.string().max(200).refine(isExpoToken, "Not an Expo push token"),
        platform: z.enum(["android", "ios"]),
      })
      .strict()
      .parse(req.body);
    pushStore.add(String(res.locals.deviceId), body.token, body.platform);
    res.json({ ok: true, push: Boolean(config.push?.enabled) });
  });
  app.delete("/api/devices/push", (req, res) => {
    const body = z
      .object({ token: z.string().max(200) })
      .strict()
      .parse(req.body);
    pushStore.remove(body.token);
    res.json({ ok: true });
  });
  app.post("/api/logout", (req, res) => {
    const value = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("infinite="))
      ?.slice(9);
    if (value) cookies.delete(hashToken(value));
    res.clearCookie("infinite", { path: "/api" });
    res.json({ ok: true });
  });
  app.get("/api/sessions", async (_req, res) =>
    res.json({ sessions: await listSessions() }),
  );
  app.post("/api/sessions", requireRole(["owner"]), async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ code: "invalid-create", error: "Invalid session details", details: parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) });
    const request = parsed.data;
    if (request.workspace && (!res.locals.bearer || runtimeSecurity(config.deployment).tenancy !== "single-tenant"))
      return void res.status(403).json({ error: "Laptop execution requires an owner device key and a single-tenant host" });
    if (request.backend === "cmux") {
      if (!cmux) return void res.status(409).json({ error: "cmux is not enabled on this machine" });
      if (request.nativeArgs || request.workspace || request.localUi) return void res.status(400).json({ error: "Choose a configured project and agent for cmux" });
      return void res.status(201).json(await cmux.create(request));
    }
    const { backend: _backend, ...nativeRequest } = request;
    if (refusedWhileApplying(request.projectId, res)) return;
    res.status(201).json(await manager.create(nativeRequest));
  });
  // Imported sessions keep their own transport and journal. Authorization is the same
  // as the managed-worker routes; raw native gateways remain worker-only.
  app.use("/api/sessions/:id", async (req, res, next) => {
    if (!cmux) return next();
    const sessionId = id.parse(req.params.id);
    if (existsSync(join(config.stateDir, "sessions", sessionId, "meta.sealed"))) return next();
    const action = req.path;
    if (req.method === "GET") {
      if (action === "/" || action === "") {
        const session = await cmux.get(sessionId);
        return void res.json({ ...session, machineId: config.machine!.id, resumable: resumable(session) });
      }
      if (action === "/events") {
        await cmux.get(sessionId);
        const after = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).parse(req.query.after);
        const limit = z.coerce.number().int().min(1).max(200).default(200).parse(req.query.limit);
        const page = cmux.events(sessionId, after, limit);
        const types = typeof req.query.types === "string" ? new Set(req.query.types.split(",")) : undefined;
        return void res.json({ ...page, events: types ? page.events.filter(e => types.has(e.type)) : page.events });
      }
      if (action === "/messages") return void res.json(await cmux.messages(sessionId,
        z.string().max(100).optional().parse(req.query.after), z.coerce.number().int().min(1).max(200).default(200).parse(req.query.limit)));
      if (action === "/file") return void res.json(await sessionFile(await cmux.get(sessionId), z.string().parse(req.query.path)));
      return void res.status(409).json({ error: "This action is unavailable for cmux sessions", code: "unsupported" });
    }
    if (req.method !== "POST") return void res.status(405).json({ error: "Unsupported method" });
    const roles = ["/stop", "/resize", "/resume"].includes(action) ? ["owner"] : ["owner", "controller"];
    if (!roles.includes(res.locals.role)) return void res.status(403).json({ error: "This device is not allowed to perform that action" });
    const authority = { actor: res.locals.actor, leaseId: res.locals.leaseId };
    try {
      if (action === "/control") {
        const body = z.object({ action: z.enum(["claim", "renew", "release"]), leaseId: id.optional(), takeover: z.boolean().optional() }).strict().parse(req.body);
        return void res.json({ control: await cmux.call(sessionId, { op: "control", ...body, actor: res.locals.actor }) });
      }
      if (action === "/input") return void res.json(await cmux.call(sessionId, { op: "input", ...inputSchema.parse(req.body), ...authority }));
      if (action === "/answer") return void res.json(await cmux.call(sessionId, { op: "answer", ...answerSchema.parse(req.body), ...authority }));
      if (action === "/key") {
        const body = z.object({ requestId: id, key: z.enum(["interrupt", "enter", "escape", "up", "down", "tab"]) }).strict().parse(req.body);
        return void res.json(await cmux.call(sessionId, { op: "key", ...body, ...authority }));
      }
      if (action === "/stop") return void res.json(await cmux.call(sessionId, { op: "stop", ...z.object({ requestId: id }).strict().parse(req.body), ...authority }));
      if (action === "/resume") return void res.json(await cmux.resume(sessionId, z.object({ requestId: id }).strict().parse(req.body).requestId));
      return void res.status(409).json({ error: "This action is unavailable for cmux sessions", code: "unsupported" });
    } catch (error) {
      const code = (error as WorkerError).code;
      if (code === "prompt-open" || (code && ANSWER_REFUSALS.has(code)))
        return void res.status(409).json({ error: code, attention: (await cmux.get(sessionId)).attention });
      throw error;
    }
  });
  app.get("/api/sessions/:id", async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const session = {
      ...manager.meta(sessionId).session,
      ...(await manager.state(sessionId, true)),
    };
    res.json({ ...session, backend: "infinite", machineId: config.machine!.id, resumable: resumable(session) });
  });
  app.get("/api/sessions/:id/messages", (req, res) => {
    const session = manager.meta(id.parse(req.params.id)).session;
    res.json(recordedMessages(manager, session, z.string().max(100).optional().parse(req.query.after),
      z.coerce.number().int().min(1).max(200).default(200).parse(req.query.limit)));
  });
  app.get("/api/sessions/:id/file", async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const session = manager.meta(sessionId).session;
    if (session.workspace) throw new ContentError("Hybrid files must be inspected on their executor or through an explicit recovery copy");
    res.json(await sessionFile(session, z.string().parse(req.query.path)));
  });
  app.post("/api/sessions/:id/resume", requireRole(["owner"]), async (req, res) => {
    const sessionId = id.parse(req.params.id);
    const { requestId } = z.object({ requestId: id }).strict().parse(req.body);
    if (refusedWhileApplying(manager.meta(sessionId).session.projectId, res)) return;
    res.json(await manager.resume(sessionId, requestId));
  });
  app.get("/api/sessions/:id/native", requireRole(["owner"]), async (req, res) => {
    if (!res.locals.bearer) return res.status(403).json({ error: "Pair an owner CLI to use the native frontend" });
    const sessionId = id.parse(req.params.id);
    if (!manager.meta(sessionId).session.runtime?.nativeUi) return res.status(409).json({ error: "This session uses its original terminal transport" });
    res.json(await workerCall(config.runDir, sessionId, { op: "native-info" }));
  });
  app.post("/api/sessions/:id/workspace-export", requireRole(["owner"]), async (req, res) => {
    if (!res.locals.bearer || req.headers.origin) return void res.status(403).json({ error: "Workspace recovery requires a paired owner CLI" });
    const sessionId = id.parse(req.params.id);
    if (!manager.meta(sessionId).session.workspace) return void res.status(409).json({ error: "This session has no hybrid workspace" });
    const request = z.object({ method: z.enum(["sync/export", "sync/blob"]), hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(req.body);
    if (request.method === "sync/blob" && !request.hash) return void res.status(400).json({ error: "A content hash is required" });
    res.json(await workerCall(config.runDir, sessionId, { op: "workspace-export", ...request }, 300000));
  });
  app.all(/^\/api\/sessions\/([a-f\d-]{36})\/opencode(\/.*)?$/, requireRole(["owner"]), async (req, res) => {
    if (!res.locals.bearer || req.headers.origin || !res.locals.leaseId) return void res.status(403).json({ error: "Native access requires an owner CLI and current control" });
    const sessionId = id.parse(req.params[0]);
    if (manager.meta(sessionId).session.runtime?.nativeUi !== "opencode") return void res.status(409).json({ error: "This session does not use an OpenCode server" });
    const backend = await workerCall<{ url: string; token: string }>(config.runDir, sessionId, { op: "native-connect", actor: res.locals.actor, leaseId: res.locals.leaseId });
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(backend.url)) throw new Error("Invalid native endpoint");
    const path = new URL(req.originalUrl, origin).pathname.slice(`/api/sessions/${sessionId}/opencode`.length) || "/";
    const query = new URL(req.originalUrl, origin).search;
    proxyNativeHttp(req, res, new URL(backend.url + path + query), { Authorization: backend.token }, req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body)));
  });
  app.get("/api/sessions/:id/events", (req, res) => {
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0)
      .parse(req.query.after);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(200)
      .parse(req.query.limit);
    const types =
      typeof req.query.types === "string"
        ? new Set(
            z
              .array(
                z.enum([
                  "output",
                  "lifecycle",
                  "input-intent",
                  "input-result",
                  "signal",
                ]),
              )
              .min(1)
              .max(5)
              .parse(req.query.types.split(",")),
          )
        : undefined;
    res.json(manager.events(id.parse(req.params.id), after, limit, types));
  });
  app.post("/api/sessions/:id/control", requireRole(["owner", "controller"]), async (req, res) => {
    const sessionId = id.parse(req.params.id);
    manager.meta(sessionId);
    const body = z.object({
      action: z.enum(["claim", "renew", "release"]),
      leaseId: id.optional(),
      takeover: z.boolean().optional(),
    }).strict().parse(req.body);
    if (!(await manager.state(sessionId)).capabilities?.inputControl)
      return void res.status(409).json({ error: "This session uses an older worker without input control", code: "unsupported" });
    res.json({ control: await workerCall(config.runDir, sessionId, { op: "control", ...body, actor: res.locals.actor }) });
  });
  // Only a directly paired owner CLI can send terminal control bytes. Browser
  // cookies and controller/viewer keys retain their existing narrower inputs.
  app.post("/api/sessions/:id/raw", requireRole(["owner"]), async (req, res) => {
    if (!res.locals.bearer) return res.status(403).json({ error: "Pair an owner CLI to use native input" });
    const sessionId = id.parse(req.params.id);
    manager.meta(sessionId);
    const body = z.object({ requestId: id, text: z.string().min(1).max(8192) }).strict().parse(req.body);
    res.json(await workerCall<Receipt>(config.runDir, sessionId, { op: "raw", ...body, ...await inputAuthority(sessionId, res) }));
  });
  app.get("/api/sessions/:id/stream", async (req, res) => {
    const sessionId = id.parse(req.params.id);
    manager.meta(sessionId);
    let cursor = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0).parse(req.query.after);
    res.set({ "Content-Type": "application/x-ndjson", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const send = async (value: unknown) => {
      if (res.destroyed) return;
      if (!res.write(JSON.stringify(value) + "\n")) {
        await new Promise<void>((resolve) => {
          const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
          res.once("drain", done); res.once("close", done);
        });
      }
    };
    try {
      for await (const page of terminalPages(manager, sessionId, cursor, abort.signal, req.query.snapshot === "1")) await send(page);
    } catch {
      if (!res.destroyed) await send({ error: "Recording stream interrupted; reconnect to replay from the last cursor" });
    } finally { res.end(); }
  });
  app.post(
    "/api/sessions/:id/input",
    requireRole(["owner", "controller"]),
    async (req, res) => {
      const sessionId = id.parse(req.params.id);
      manager.meta(sessionId);
      const body = inputSchema.parse(req.body);
      try {
        res.json(
          await workerCall<Receipt>(config.runDir, sessionId, {
            op: "input",
            ...body,
            ...await inputAuthority(sessionId, res),
          }),
        );
      } catch (error) {
        // A dialog is open: the text would land in it, so nothing was typed.
        if ((error as WorkerError).code === "prompt-open")
          return void res.status(409).json({
            error: "prompt-open",
            attention: (await manager.state(sessionId)).attention,
          });
        throw error;
      }
    },
  );
  app.post(
    "/api/sessions/:id/answer",
    requireRole(["owner", "controller"]),
    async (req, res) => {
      const sessionId = id.parse(req.params.id);
      manager.meta(sessionId);
      const body = answerSchema.parse(req.body);
      try {
        // An answer waits for the dialog to redraw and close, so it gets more than the default 4 s.
        res.json(
          await workerCall(
            config.runDir,
            sessionId,
            { op: "answer", ...body, ...await inputAuthority(sessionId, res) },
            12000,
          ),
        );
      } catch (error) {
        const code = (error as WorkerError).code;
        if (code && ANSWER_REFUSALS.has(code))
          return void res.status(409).json({
            error: code,
            attention: (await manager.state(sessionId)).attention,
          });
        throw error;
      }
    },
  );
  app.post(
    "/api/sessions/:id/key",
    requireRole(["owner", "controller"]),
    async (req, res) => {
      const sessionId = id.parse(req.params.id);
      manager.meta(sessionId);
      const body = z
        .object({
          requestId: id,
          key: z.enum(["interrupt", "enter", "escape", "up", "down", "tab"]),
        })
        .strict()
        .parse(req.body);
      res.json(
        await workerCall(config.runDir, sessionId, { op: "key", ...body, ...await inputAuthority(sessionId, res) }),
      );
    },
  );
  app.post(
    "/api/sessions/:id/stop",
    requireRole(["owner"]),
    async (req, res) => {
      const sessionId = id.parse(req.params.id);
      manager.meta(sessionId);
      const body = z.object({ requestId: id }).strict().parse(req.body);
      res.json(
        await workerCall(config.runDir, sessionId, { op: "stop", ...body, ...await inputAuthority(sessionId, res) }),
      );
    },
  );
  app.post(
    "/api/sessions/:id/resize",
    requireRole(["owner"]),
    async (req, res) => {
      const sessionId = id.parse(req.params.id);
      manager.meta(sessionId);
      const body = z
        .object({
          cols: z.number().int().min(20).max(240),
          rows: z.number().int().min(5).max(100),
        })
        .strict()
        .parse(req.body);
      res.json(
        await workerCall(config.runDir, sessionId, { op: "resize", ...body, ...await inputAuthority(sessionId, res) }),
      );
    },
  );
  app.get("/api/projects/:id", (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    const project = config.projects.find(p => p.id === projectId);
    if (!project) return res.status(404).json({ error: "Unknown project" });
    return res.json({ id: project.id, name: project.name, sync: projectSync.status(projectId) });
  });
  app.post("/api/projects/:id/sync/begin", requireRole(["owner"]), (req, res) => {
    if (!res.locals.bearer) return res.status(403).json({ error: "Workspace sync requires a paired owner CLI" });
    return res.json(projectSync.begin(projectSchema.parse(req.params.id)));
  });
  app.post("/api/projects/:id/sync/has", requireRole(["owner"]), async (req, res) => {
    const body = z.object({ hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(512) }).strict().parse(req.body);
    res.json({ missing: await projectSync.missing(projectSchema.parse(req.params.id), body.hashes) });
  });
  app.put("/api/projects/:id/sync/blob/:hash", requireRole(["owner"]), express.raw({ type: "application/octet-stream", limit: "1mb" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return void res.status(400).json({ error: "Send the chunk as application/octet-stream" });
    await projectSync.putBlob(projectSchema.parse(req.params.id), String(req.params.hash), req.body);
    res.json({ stored: true });
  });
  app.post("/api/projects/:id/sync/commit", requireRole(["owner"]), async (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    const body = z.object({ generation: z.uuid(), manifest: z.unknown() }).strict().parse(req.body);
    res.json(await projectSync.commit(projectId, body.generation, body.manifest, await projectRunning(projectId)));
  });
  app.post("/api/projects/:id/sync/apply", requireRole(["owner"]), async (req, res) => {
    const projectId = projectSchema.parse(req.params.id);
    const body = z.object({ force: z.boolean().optional() }).strict().parse(req.body ?? {});
    res.json(await projectSync.apply(projectId, { force: body.force, running: await projectRunning(projectId) }));
  });
  app.post("/api/projects/:id/sync/export", requireRole(["owner"]), async (req, res) => {
    if (!res.locals.bearer) return void res.status(403).json({ error: "Workspace export requires a paired owner CLI" });
    res.json({ manifest: await projectSync.exportTree(projectSchema.parse(req.params.id)) });
  });
  app.get("/api/projects/:id/sync/blob/:hash", requireRole(["owner"]), async (req, res) => {
    res.json({ base64: await projectSync.readBlob(projectSchema.parse(req.params.id), String(req.params.hash)) });
  });
  app.get("/api/projects/:id/context", (req, res) => {
    if (!config.projects.some((p) => p.id === req.params.id))
      return res.status(404).json({ error: "Unknown project" });
    return res.json(manager.context(req.params.id));
  });
  app.put("/api/projects/:id/context", requireRole(["owner"]), (req, res) => {
    if (!config.projects.some((p) => p.id === req.params.id))
      return res.status(404).json({ error: "Unknown project" });
    const body = z
      .object({
        text: z.string().max(24000),
        expectedVersion: z.number().int().min(0),
      })
      .strict()
      .parse(req.body);
    return res.json(
      manager.setContext(
        String(req.params.id),
        body.text,
        body.expectedVersion,
      ),
    );
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Endpoint not found" }),
  );
  app.use(
    express.static(
      fileURLToPath(new URL("../../../apps/web/dist/", import.meta.url)),
    ),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof ProjectSyncError) return res.status(error.status).json({ code: error.code, error: error.message });
      if (error instanceof ContentError) return res.status(error.status).json({ error: error.message });
      if (error instanceof z.ZodError)
        return res.status(400).json({
          error: "Invalid request",
          details: error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return res.status(404).json({ error: "Session not found" });
      if (error instanceof SyntaxError)
        return res.status(400).json({ error: "Invalid JSON" });
      if (["control-busy", "control-lost"].includes((error as WorkerError).code ?? ""))
        return res.status(409).json({
          code: (error as WorkerError).code,
          error: (error as WorkerError).code === "control-busy"
            ? "Another device controls this session. Take over explicitly to send input."
            : "Control changed or expired. This input was not sent. Refresh and take control again.",
        });
      if (error instanceof CmuxError) {
        const status = ["cmux-unavailable", "session-unavailable", "cmux-busy"].includes(error.code) ? 503
          : ["invalid-cursor", "invalid-control"].includes(error.code) ? 400 : 409;
        return res.status(status).json({ code: error.code, error: error.message });
      }
      // Never echo filesystem paths, prompts, tokens, or child process details.
      return res.status(409).json({
        error:
          "Operation could not be completed. Refresh the session before retrying. Input delivery may be uncertain.",
      });
    },
  );
  const server = createServer(app);
  const closeTerminals = connectTerminals(server, manager, authenticate);
  const closeNative = connectNativeFrontends(server, manager, authenticate);
  const closeRemote = connectRemoteAccess(server, config);
  const closeConnections = () => { closeTerminals(); closeNative(); closeRemote(); cmux?.close(); server.closeAllConnections(); };
  return { app, manager, projectSync, sessions: { list: listSessions }, pushStore, server, closeConnections };
}
