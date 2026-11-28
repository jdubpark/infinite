import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (args.includes("--help")) { console.log("--remote --remote-auth-token-env --ws-token-sha256 --ws-auth"); process.exit(0); }
if (args[0] === "exec-server") {
  const server = createServer(), sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (req.headers.origin || createHash("sha256").update(token).digest("hex") !== option("--ws-token-sha256")) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
    }
    sockets.handleUpgrade(req, socket, head, client => {
      client.on("error", () => {});
      client.on("message", data => {
        const request = JSON.parse(data.toString());
        if (request.method === "fixture/read-write") {
          const contents = readFileSync("marker.txt", "utf8");
          appendFileSync("agent-edit.txt", contents + "\n");
          client.send(JSON.stringify({ id: request.id, result: { contents, cwd: process.cwd() } }));
        } else if (request.method === "fixture/uncertain-edit") {
          appendFileSync("uncertain-effect.txt", "performed\n");
        } else if (request.method === "fs/getMetadata") {
          const target = typeof request.params?.path === "string" ? request.params.path : join(process.cwd(), "AGENTS.md");
          client.send(JSON.stringify({ id: request.id, result: { exists: existsSync(target), isFile: existsSync(target) } }));
        } else if (request.method === "fs/readFile") {
          const target = typeof request.params?.path === "string" ? request.params.path : join(process.cwd(), "AGENTS.md");
          client.send(JSON.stringify({ id: request.id, result: { contents: existsSync(target) ? readFileSync(target, "utf8") : "" } }));
        } else client.send(JSON.stringify({ id: request.id, result: { cwd: pathToFileURL(process.cwd()).href } }));
      });
    });
  });
  server.listen(0, "127.0.0.1", () => {
    writeFileSync("executor-pid", String(process.pid));
    console.log(`listening on: ws://127.0.0.1:${server.address().port}`);
  });
} else if (args[0] === "app-server") {
  const expectedHash = option("--ws-token-sha256");
  const stateFile = process.env.FIXTURE_THREAD_STATE_FILE;
  const omitStartEnvironments = process.env.FIXTURE_OMIT_START_ENVIRONMENTS === "1";
  const omitReadEnvironments = process.env.FIXTURE_OMIT_READ_ENVIRONMENTS === "1";
  const omitReadFlagFile = process.env.FIXTURE_OMIT_READ_FLAG_FILE;
  const omitResumeEnvironments = process.env.FIXTURE_OMIT_RESUME_ENVIRONMENTS === "1";
  const holdFrontendReadFile = process.env.FIXTURE_HOLD_FRONTEND_READ_FILE;
  const floodDuringStartRead = process.env.FIXTURE_FLOOD_DURING_START_READ === "1";
  const startupWriteAttempt = process.env.FIXTURE_STARTUP_WRITE_ATTEMPT === "1";
  const omitUserAgent = process.env.FIXTURE_OMIT_USER_AGENT === "1";
  const fixtureUserAgent = process.env.FIXTURE_USER_AGENT ?? "native-fixture";
  const fixtureCapabilities = process.env.FIXTURE_CAPABILITIES ? JSON.parse(process.env.FIXTURE_CAPABILITIES) : undefined;
  const defaultHistoryMode = process.env.FIXTURE_DEFAULT_HISTORY_MODE ?? "legacy";
  const requireLegacyHistory = process.env.FIXTURE_REQUIRE_LEGACY_HISTORY === "1";
  const unsupportedPagination = process.env.FIXTURE_UNSUPPORTED_PAGINATION === "1";
  const failThreadStartMessage = process.env.FIXTURE_FAIL_THREAD_START_MESSAGE;
  const unmaterializedFlagFile = process.env.FIXTURE_UNMATERIALIZED_FLAG_FILE;
  const delayEmptyFirstTurnsListMs = Number(process.env.FIXTURE_DELAY_EMPTY_FIRST_TURNS_LIST_MS ?? "0");
  let delayedEmptyTurnsListSent = false;
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const saved = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : undefined;
  const history = Array.isArray(saved?.history) ? [...saved.history] : [];
  const turns = Array.isArray(saved?.turns) ? [...saved.turns] : [];
  let threadId = saved?.threadId, historyMode = saved?.historyMode, activeTurn, selections = saved?.selections, activeSelections = saved?.selections, releaseHeldTurn, replayCompletedTurn;
  let discoveredInstructions, startupWriteBlocked;
  let flooded = false;
  const saveState = () => {
    if (!stateFile) return;
    writeFileSync(stateFile, JSON.stringify({ threadId, historyMode, history, turns, selections }));
  };
  const environments = new Map();
  const execute = (environmentId, method, params) => new Promise((resolve, reject) => {
    const environment = environments.get(environmentId);
    const ws = new WebSocket(environment.execServerUrl, { headers: { Authorization: `Bearer ${environment.authBearerToken}` } });
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, ...(params !== undefined ? { params } : {}) })));
    ws.on("message", data => {
      const response = JSON.parse(data.toString());
      if (response.error) reject(new Error(response.error.message)); else resolve(response.result);
      ws.close();
    });
  });
  const foreignId = randomUUID();
  const broadcast = message => { for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); };
  const isUnmaterialized = () => Boolean(unmaterializedFlagFile && existsSync(unmaterializedFlagFile));
  const paginate = (entries, params, defaultSort, kind) => {
    const dir = params?.sortDirection === "asc" || params?.sortDirection === "desc" ? params.sortDirection : defaultSort;
    const ordered = dir === "desc" ? [...entries].reverse() : [...entries];
    let start = 0;
    if (params?.cursor !== undefined && params?.cursor !== null) {
      if (typeof params.cursor !== "string") return { error: "Invalid cursor" };
      const match = params.cursor.match(new RegExp(`^${kind}:${dir}:(\\d+)(?::.+)?$`));
      if (!match) return { error: `Invalid ${kind} cursor for sortDirection ${dir}` };
      start = Number(match[1]);
    }
    const limit = typeof params?.limit === "number" && params.limit > 0 ? params.limit : ordered.length;
    const data = ordered.slice(start, start + limit);
    return {
      data,
      nextCursor: start + data.length < ordered.length ? `${kind}:${dir}:${start + data.length}` : null,
      backwardsCursor: data.length > 0 ? `${kind}:${dir === "desc" ? "asc" : "desc"}:${ordered.length - 1 - start}` : null,
    };
  };
  const formatTurn = (entry, itemsView) => ({
    id: entry.id,
    text: entry.text,
    status: entry.status,
    ...(entry.error ? { error: entry.error } : {}),
    items: itemsView === "notLoaded" ? [] : itemsView === "full" ? entry.items : entry.items.slice(0, 1),
  });
  const thread = (includeEnvironments = true, includeTurns = true) => ({
    id: threadId,
    ...(historyMode === "paginated"
      ? {
          historyMode: "paginated",
          turns: includeTurns
            ? turns.map(entry => ({ id: entry.id, text: entry.text, status: entry.status, ...(entry.error ? { error: entry.error } : {}) }))
            : [],
        }
      : { turns: includeTurns ? history.map(text => ({ text })) : [] }),
    ...(includeEnvironments && selections ? { environments: selections, cwd: selections[0].cwd } : {}),
    ...(discoveredInstructions !== undefined ? { discoveredInstructions } : {}),
    ...(startupWriteBlocked !== undefined ? { startupWriteBlocked } : {}),
  });
  http.on("upgrade", (req, socket, head) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (createHash("sha256").update(token).digest("hex") !== expectedHash) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const upgrade = () => {
      if (socket.destroyed) return;
      if (existsSync("hold-upgrades")) { writeFileSync("upgrade-held", "held"); setTimeout(upgrade, 10); return; }
      wss.handleUpgrade(req, socket, head, client => {
      client.on("error", () => {});
      let clientName;
      client.on("message", async data => {
        const message = JSON.parse(data.toString());
        const { method, params, id } = message;
        if (method) appendFileSync("provider-requests.jsonl", JSON.stringify({ method, params }) + "\n");
        const reply = result => client.send(JSON.stringify({ id, result }));
        const replyError = (code, reason) => client.send(JSON.stringify({ id, error: { code, message: reason } }));
        if (method === "initialize") {
          clientName = params?.clientInfo?.name;
          reply({
            ...(!omitUserAgent ? { userAgent: fixtureUserAgent } : {}),
            ...(fixtureCapabilities !== undefined ? { capabilities: fixtureCapabilities } : {}),
          });
        }
        else if (method === "server/diagnostics") reply({ executionEnvironmentUpdates: 1 });
        else if (method === "environment/add") {
          environments.set(params.environmentId, params); reply({});
          if (clientName === "infinite_execution" && replayCompletedTurn) {
            const replay = { threadId, turnId: replayCompletedTurn };
            client.send(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: replay.turnId, status: "inProgress" } } }));
            client.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: replay.turnId, status: "completed" } } }));
            writeFileSync("provider-lifecycle-replay.json", JSON.stringify(replay));
            replayCompletedTurn = undefined;
          }
        }
        else if (method === "environment/info") reply(await execute(params.environmentId, "environment/info"));
        else if (method === "thread/start") {
          if (failThreadStartMessage) {
            replyError(-32000, failThreadStartMessage);
            return;
          }
          if (unsupportedPagination && params?.historyMode !== "legacy") {
            replyError(-32600, "paginated threads require thread/turns/list and thread/items/list support");
            return;
          }
          if (requireLegacyHistory && params?.historyMode !== "legacy") {
            replyError(-32602, "Server requires historyMode: legacy");
            return;
          }
          threadId = randomUUID();
          historyMode = params?.historyMode ?? defaultHistoryMode;
          selections = params?.environments;
          activeSelections = params?.environments;
          if (selections?.length && process.env.FIXTURE_STARTUP_DISCOVERY === "1") {
            const env = selections[0];
            const instructionsPath = join(env.cwd, "AGENTS.md");
            const meta = await execute(env.environmentId, "fs/getMetadata", { path: instructionsPath });
            if (meta?.exists) {
              const file = await execute(env.environmentId, "fs/readFile", { path: instructionsPath });
              discoveredInstructions = file?.contents ?? "";
            }
            if (startupWriteAttempt) {
              try {
                await execute(env.environmentId, "fs/writeFile", { path: join(env.cwd, "pwn.txt"), contents: "bad" });
                startupWriteBlocked = false;
              } catch {
                startupWriteBlocked = true;
              }
            }
          }
          saveState();
          const startThread = thread(!omitStartEnvironments, false);
          reply({ thread: startThread }); broadcast({ method: "thread/started", params: { thread: startThread } });
        }
        else if (method === "thread/settings/update") { if (params.environments) selections = params.environments; saveState(); reply({}); }
        else if (method === "fixture/release-turn") {
          const release = releaseHeldTurn;
          if (!release) { reply({ released: false }); return; }
          releaseHeldTurn = undefined; release(); reply({ released: true });
        }
        else if (method === "turn/settings/update") {
          if (params.turnId !== activeTurn) reply({ status: "targetUnavailable" });
          else { if (params.environments) activeSelections = params.environments; reply({ status: "applied" }); }
        }
        else if (method === "thread/read" || method === "thread/resume") {
          if (method === "thread/read" && params?.includeTurns === true && isUnmaterialized()) {
            replyError(-32600, "includeTurns is unavailable before first user message");
            return;
          }
          const omitReadNow = omitReadEnvironments || Boolean(omitReadFlagFile && existsSync(omitReadFlagFile));
          const includeEnvs = method === "thread/read" ? !omitReadNow : (!omitStartEnvironments && !omitResumeEnvironments);
          const includeTurns = historyMode !== "paginated"
            ? (method === "thread/read" ? params?.includeTurns !== false : true)
            : method === "thread/read"
              ? params?.includeTurns === true
              : params?.excludeTurns !== true;
          if (method === "thread/read" && clientName === "infinite_execution" && floodDuringStartRead && !flooded) {
            flooded = true;
            const big = "x".repeat(15 * 1024 * 1024);
            const payload = JSON.stringify({ method: "fixture/flood", params: { threadId, chunk: big } });
            const targets = [...wss.clients].filter(peer => peer !== client && peer.readyState === WebSocket.OPEN);
            for (const peer of targets) {
              for (let i = 0; i < 5; i++) {
                if (peer.readyState !== WebSocket.OPEN) break;
                await new Promise(done => peer.send(payload, () => done()));
              }
            }
            const until = Date.now() + 2000;
            while (Date.now() < until && targets.some(peer => peer.readyState === WebSocket.OPEN)) {
              await new Promise(done => setTimeout(done, 25));
            }
          }
          if (method === "thread/read" && clientName !== "infinite_execution" && holdFrontendReadFile && existsSync(holdFrontendReadFile)) {
            const snapshot = thread(includeEnvs, includeTurns);
            const waitRelease = () => {
              if (!existsSync(holdFrontendReadFile)) {
                reply({ thread: snapshot, pid: process.pid });
              } else {
                setTimeout(waitRelease, 15);
              }
            };
            waitRelease();
            return;
          }
          if (method === "thread/resume" && selections?.length && process.env.FIXTURE_STARTUP_DISCOVERY === "1" && environments.has(selections[0].environmentId)) {
            const env = selections[0];
            const instructionsPath = join(env.cwd, "AGENTS.md");
            const meta = await execute(env.environmentId, "fs/getMetadata", { path: instructionsPath });
            if (meta?.exists) {
              const file = await execute(env.environmentId, "fs/readFile", { path: instructionsPath });
              discoveredInstructions = file?.contents ?? "";
            }
          }
          const allItems = turns.flatMap(entry => entry.items);
          const resumeMeta = method === "thread/resume" && historyMode === "paginated"
            ? {
                turnsBackwardsCursor: turns.length > 0 ? `turns:desc:0:${turns.at(-1).id}` : null,
                itemsBackwardsCursor: allItems.length > 0 ? `items:desc:0:${allItems.at(-1).id}` : null,
                ...(params?.initialTurnsPage
                  ? { initialTurnsPage: paginate(turns.map(entry => formatTurn(entry, params.initialTurnsPage.itemsView)), params.initialTurnsPage, "desc", "turns") }
                  : {}),
              }
            : {};
          reply({ thread: thread(includeEnvs, includeTurns), pid: process.pid, ...resumeMeta });
        }
        else if (method === "thread/turns/list") {
          if (!threadId || params?.threadId !== threadId) { replyError(-32600, "Unknown threadId"); return; }
          if (isUnmaterialized()) { replyError(-32600, `thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`); return; }
          if (delayEmptyFirstTurnsListMs > 0 && !delayedEmptyTurnsListSent) {
            delayedEmptyTurnsListSent = true;
            setTimeout(() => reply({ data: [], nextCursor: null, backwardsCursor: null }), delayEmptyFirstTurnsListMs);
            return;
          }
          const page = paginate(turns.map(entry => formatTurn(entry, params?.itemsView)), params, "desc", "turns");
          if ("error" in page) { replyError(-32602, page.error); return; }
          reply(page);
        }
        else if (method === "thread/items/list") {
          if (!threadId || params?.threadId !== threadId) { replyError(-32600, "Unknown threadId"); return; }
          if (isUnmaterialized()) { replyError(-32600, `thread ${threadId} is not materialized yet; thread/items/list is unavailable before first user message`); return; }
          const selected = typeof params?.turnId === "string" ? turns.filter(entry => entry.id === params.turnId) : turns;
          const entries = selected.flatMap(entry => entry.items.map(item => ({ turnId: entry.id, item })));
          const page = paginate(entries, params, "asc", "items");
          if ("error" in page) { replyError(-32602, page.error); return; }
          reply(page);
        }
        else if (method === "thread/items/read") {
          if (!threadId || params?.threadId !== threadId) { replyError(-32600, "Unknown threadId"); return; }
          const target = turns.find(entry => entry.id === params?.turnId);
          const wanted = Array.isArray(params?.itemIds) ? new Set(params.itemIds) : new Set();
          reply({ items: target ? target.items.filter(item => wanted.has(item.id)) : [] });
        }
        else if (method === "thread/timeline/list") {
          if (!threadId || params?.threadId !== threadId) { replyError(-32600, "Unknown threadId"); return; }
          const entries = turns.flatMap(entry => entry.items.map(item => ({ turnId: entry.id, item })));
          const page = paginate(entries, params, "asc", "timeline");
          if ("error" in page) { replyError(-32602, page.error); return; }
          reply({ data: page.data, nextCursor: page.nextCursor });
        }
        else if (method === "thread/list") reply({ data: [thread(), { id: foreignId }], nextCursor: "next" });
        else if (method === "thread/loaded/list") reply({ data: [threadId, foreignId] });
        else if (method === "plugin/list") reply({ catalog: "a".repeat(13 * 1024 * 1024) });
        else if (method === "turn/start") {
          const text = params.input.map(item => item.text ?? "").join("");
          const turnId = randomUUID();
          history.push(text);
          const turnEntry = {
            id: turnId,
            text,
            status: "inProgress",
            items: [
              { id: `${turnId}:user`, type: "userMessage", text },
              { id: `${turnId}:agent`, type: "agentMessage", text: `reply:${text}` },
            ],
          };
          turns.push(turnEntry);
          saveState();
          activeTurn = turnId; activeSelections = params.environments ?? selections;
          const complete = (status = "completed", error) => {
            if (activeTurn === turnId) activeTurn = undefined;
            turnEntry.status = status;
            if (error) turnEntry.error = error;
            saveState();
            broadcast({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, ...(error ? { error } : {}) } } });
          };
          reply({ turn: { id: turnId, status: "inProgress" } });
          broadcast({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
          broadcast({ method: "item/completed", params: { threadId, item: { text } } });
          if (["workspace edit", "workspace edit held", "uncertain edit"].includes(text) && activeSelections?.length) {
            try {
              const result = await execute(activeSelections[0].environmentId, text === "uncertain edit" ? "fixture/uncertain-edit" : "fixture/read-write");
              broadcast({ method: "item/completed", params: { threadId, item: { text: result.contents } } });
              if (text === "workspace edit held") await new Promise(resolve => {
                releaseHeldTurn = resolve;
                broadcast({ method: "fixture/turn-held", params: { threadId, turnId } });
              });
              if (text === "workspace edit held") replayCompletedTurn = turnId;
              complete();
            } catch { complete("failed"); }
          }
          if (text === "complete") complete();
          if (text === "usage-limit") complete("failed", { codexErrorInfo: "usageLimitExceeded" });
          if (text === "rate-limit-transient") complete("failed", { codexErrorInfo: "rateLimitExceeded" });
          if (text === "work") setTimeout(() => { writeFileSync("work-complete", "done"); complete(); }, 1200);
          if (text === "approval") broadcast({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId, command: "fixture" } });
        } else if (!method && id === "approval") writeFileSync("approval-result.json", JSON.stringify(message));
        else if (id !== undefined) reply({});
      });
      });
    };
    upgrade();
  });
  http.listen(0, "127.0.0.1", () => {
    writeFileSync("provider-pid", String(process.pid));
    console.log(`listening on: ws://127.0.0.1:${http.address().port}`);
  });
} else {
  const resuming = args.includes("resume");
  const prompt = args.includes("--") ? args[args.indexOf("--") + 1] : undefined;
  if (resuming) writeFileSync("native-client.json", JSON.stringify({ args, tokenHash: createHash("sha256").update(process.env[option("--remote-auth-token-env")] ?? "").digest("hex") }));
  const ws = new WebSocket(option("--remote"), { headers: { Authorization: `Bearer ${process.env[option("--remote-auth-token-env")]}` } });
  let threadId, next = 10;
  const call = (method, params) => ws.send(JSON.stringify({ id: next++, method, params }));
  ws.on("open", () => call("initialize", { clientInfo: { name: "fixture", version: "1" } }));
  ws.on("message", data => {
    const message = JSON.parse(data.toString());
    if (message.id === 10) { ws.send(JSON.stringify({ method: "initialized" })); call(resuming ? "thread/resume" : "thread/start", resuming ? { threadId: args.at(-1) } : {}); }
    if (message.id === 11) {
      threadId = message.result.thread.id;
      if (resuming) call("plugin/list", {});
      else if (prompt !== undefined) call("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
    }
    if (resuming && message.id === 12) {
      writeFileSync("native-catalog.json", JSON.stringify({ bytes: message.result.catalog.length }));
      console.log("LOCAL NATIVE READY");
    }
    if (message.method === "item/completed") console.log(message.params.item.text);
    if (message.method === "turn/completed") setTimeout(() => console.log("Observer redraw after turn completed"), 80);
    if (message.method === "item/commandExecution/requestApproval") console.log("Approval requested; awaiting explicit input");
  });
  ws.on("error", () => process.exit(1));
  ws.on("close", () => process.exit(0));
  process.stdin.setRawMode(true);
  let input = "";
  process.stdin.on("data", data => {
    if (resuming && data.toString() === "\x04") process.exit(0);
    if (resuming && data.toString() === "\x18") process.kill(process.pid, "SIGKILL");
    input += data.toString().replace(/\x1b\[20[01]~/g, "");
    if (input.includes("\r") && threadId) { call("turn/start", { threadId, input: [{ type: "text", text: input.split("\r")[0] }] }); input = ""; }
  });
  process.stdout.write("\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?25l");
}
