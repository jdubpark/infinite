#!/usr/bin/env node
// GitHub credential proxy. It holds the GitHub App installation token under its own account and checks a
// host-signed grant on every request. Node standard library only. See deploy/ubuntu/github-proxy.md.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

const GRANT_OPS = new Set(["fetch", "push", "pr", "merge"]);
const GRANT_MAX_TTL_SECONDS = 24 * 60 * 60;
const GRANT_MAX_LENGTH = 4096;
const GRANT_MAX_REFS = 32;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function validRepository(value) {
  return typeof value === "string" && REPOSITORY.test(value) && !value.toLowerCase().endsWith(".git");
}

/** A full ref name, or with `pattern` a prefix ending in `/*`. Never `refs/*`, never a control or Git-special character. */
export function validRef(value, pattern) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  const wildcard = pattern && value.endsWith("/*");
  const ref = wildcard ? value.slice(0, -2) : value;
  if (!ref.startsWith("refs/") || /[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")) return false;
  const parts = ref.split("/");
  if (parts.length < (wildcard ? 2 : 3)) return false;
  return parts.every(part => part.length > 0 && part !== "@" && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function parseGrantKey(text) {
  const hex = String(text).trim();
  if (!/^(?:[0-9a-fA-F]{2}){32,128}$/.test(hex)) throw new ProxyError("grant-key-invalid");
  return Buffer.from(hex, "hex");
}

function canonicalBase64url(text) {
  if (!BASE64URL.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : undefined;
}

/**
 * Verifies `v1.<payload>.<mac>` and returns `{ ok: true, claims }` or `{ ok: false, reason }`. The MAC is compared in
 * constant time before the payload is parsed; the payload must be canonical base64url JSON with exactly the known fields.
 */
export function verifyGrant(text, key, nowSeconds = Math.floor(Date.now() / 1000)) {
  const refuse = reason => ({ ok: false, reason });
  if (typeof text !== "string" || text.length === 0 || text.length > GRANT_MAX_LENGTH) return refuse("grant-malformed");
  const parts = text.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return refuse("grant-malformed");
  const mac = canonicalBase64url(parts[2]);
  if (!mac || mac.length !== 32) return refuse("grant-malformed");
  const expected = createHmac("sha256", key).update(`v1.${parts[1]}`, "utf8").digest();
  if (!timingSafeEqual(mac, expected)) return refuse("grant-signature");
  const payload = canonicalBase64url(parts[1]);
  if (!payload) return refuse("grant-malformed");
  let claims;
  try { claims = JSON.parse(payload.toString("utf8")); } catch { return refuse("grant-malformed"); }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return refuse("grant-malformed");
  const keys = Object.keys(claims).sort().join(",");
  if (keys !== (Object.hasOwn(claims, "refs") ? "exp,ops,refs,repo,sid,sub" : "exp,ops,repo,sid,sub")) return refuse("grant-fields");
  if (typeof claims.sub !== "string" || !LABEL.test(claims.sub) || typeof claims.sid !== "string" || !LABEL.test(claims.sid)) return refuse("grant-fields");
  if (!validRepository(claims.repo)) return refuse("grant-fields");
  if (!Array.isArray(claims.ops) || claims.ops.length === 0 || new Set(claims.ops).size !== claims.ops.length || !claims.ops.every(op => typeof op === "string" && GRANT_OPS.has(op))) return refuse("grant-fields");
  if (Object.hasOwn(claims, "refs")) {
    if (!claims.ops.includes("push") || !Array.isArray(claims.refs) || claims.refs.length === 0 || claims.refs.length > GRANT_MAX_REFS ||
      new Set(claims.refs).size !== claims.refs.length || !claims.refs.every(ref => validRef(ref, true))) return refuse("grant-fields");
  }
  if (!Number.isSafeInteger(claims.exp)) return refuse("grant-fields");
  if (claims.exp <= nowSeconds) return refuse("grant-expired");
  if (claims.exp > nowSeconds + GRANT_MAX_TTL_SECONDS) return refuse("grant-lifetime");
  return { ok: true, claims };
}

/** Exact refs match exactly; a pattern ending in `/*` matches every ref under that prefix. */
export function refAllowed(refs, ref) {
  return Array.isArray(refs) && refs.some(pattern => pattern.endsWith("/*") ? ref.startsWith(pattern.slice(0, -1)) : ref === pattern);
}

export class ProxyError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration and the token cache written by github-app-refresh.mjs.

const CONFIG_KEYS = new Set(["listen", "grantKeyFile", "tokenDirectory", "githubCli", "repositories", "agentUser", "upstream"]);

function regularPrivateFile(path, code, { otherReadable }) {
  let info;
  try { info = lstatSync(path); } catch { throw new ProxyError(`${code}-unavailable`); }
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o022) !== 0 || (!otherReadable && (info.mode & 0o007) !== 0)) throw new ProxyError(`${code}-permissions`);
  return readFileSync(path, "utf8");
}

/** Validates the proxy configuration. `upstream` defaults to https://github.com; loopback is allowed for tests only. */
export function validateProxyConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !CONFIG_KEYS.has(key))) throw new ProxyError("config-shape");
  const listen = input.listen;
  if (!listen || typeof listen !== "object" || Object.keys(listen).sort().join(",") !== "host,port" || !["127.0.0.1", "::1"].includes(listen.host) ||
    !Number.isSafeInteger(listen.port) || listen.port < 0 || listen.port > 65535) throw new ProxyError("config-listen");
  for (const key of ["grantKeyFile", "tokenDirectory", "githubCli"])
    if (typeof input[key] !== "string" || !isAbsolute(input[key]) || resolve(input[key]) !== input[key]) throw new ProxyError(`config-${key}`);
  if (input.repositories !== undefined && (!Array.isArray(input.repositories) || input.repositories.length > 500 || !input.repositories.every(validRepository))) throw new ProxyError("config-repositories");
  if (input.agentUser !== undefined && (typeof input.agentUser !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.agentUser))) throw new ProxyError("config-agentUser");
  let upstream = "https://github.com";
  if (input.upstream !== undefined) {
    let url;
    try { url = new URL(input.upstream); } catch { throw new ProxyError("config-upstream"); }
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol);
    if (url.origin !== input.upstream || (!loopback && url.origin !== "https://github.com")) throw new ProxyError("config-upstream");
    upstream = url.origin;
  }
  return { ...input, upstream, repositories: input.repositories?.map(name => name.toLowerCase()) };
}

export function loadProxyConfig(path) {
  let parsed;
  try { parsed = JSON.parse(regularPrivateFile(path, "config", { otherReadable: true })); }
  catch (error) { throw error instanceof ProxyError ? error : new ProxyError("config-json"); }
  return validateProxyConfig(parsed);
}

export function loadGrantKey(path) {
  return parseGrantKey(regularPrivateFile(path, "grant-key", { otherReadable: false }));
}

const BASE_PERMISSIONS = { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", metadata: "read" };
const CACHE_KEYS = "expiresAt,installationId,permissions,repository,repositoryId,schemaVersion,token";

function validCachedToken(data, repository, nowMs) {
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).sort().join(",") !== CACHE_KEYS || data.schemaVersion !== 1) return false;
  if (typeof data.repository !== "string" || data.repository.toLowerCase() !== repository.toLowerCase()) return false;
  if (typeof data.token !== "string" || data.token.length === 0 || Buffer.byteLength(data.token) > 16384 || /[\s\u0000-\u001f\u007f]/u.test(data.token)) return false;
  const expires = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : Number.NaN;
  if (!Number.isFinite(expires) || expires < nowMs + 60_000) return false;
  const permissions = data.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return false;
  const keys = Object.keys(permissions);
  const workflow = keys.length === 7 && permissions.workflows === "write";
  if (keys.length !== 6 && !workflow) return false;
  return keys.every(key => key === "workflows" ? workflow : BASE_PERMISSIONS[key] === permissions[key]) && Object.keys(BASE_PERMISSIONS).every(key => Object.hasOwn(permissions, key));
}

/** Reads the installation token for one repository, re-reading the cache file only when it changed. */
function tokenStore(config, now) {
  const cache = new Map();
  const ownUid = typeof process.getuid === "function" ? process.getuid() : 0;
  return repository => {
    if (config.repositories && !config.repositories.includes(repository.toLowerCase())) return undefined;
    const path = join(config.tokenDirectory, `${createHash("sha256").update(repository.toLowerCase()).digest("hex")}.json`);
    let info;
    try { info = lstatSync(path); } catch { cache.delete(path); return undefined; }
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o022) !== 0 || ![0, ownUid].includes(info.uid) || info.size > 32 * 1024) return undefined;
    const stamp = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`;
    let entry = cache.get(path);
    if (entry?.stamp !== stamp) {
      let fd;
      try {
        fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const opened = fstatSync(fd);
        if (opened.dev !== info.dev || opened.ino !== info.ino) return undefined;
        entry = { stamp, data: JSON.parse(readFileSync(fd, "utf8")) };
      } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
      cache.set(path, entry);
    }
    return validCachedToken(entry.data, repository, now()) ? entry.data.token : undefined;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The receive-pack command list (gitprotocol-pack: update-request), checked before anything reaches GitHub.

const CAPABILITY_FLAGS = new Set(["report-status", "report-status-v2", "side-band-64k", "side-band", "quiet", "atomic", "ofs-delta", "push-options"]);
const MAX_PKT = 65520;

function validCapability(token) {
  if (CAPABILITY_FLAGS.has(token)) return true;
  if (/^object-format=(?:sha1|sha256)$/.test(token)) return true;
  return /^(?:agent|session-id)=[\x21-\x7e]{1,256}$/.test(token);
}

/**
 * Incremental parser for the start of a git-receive-pack request body: optional `shallow` lines, the command list up
 * to its flush packet, push options when negotiated, then the `PACK` signature. Anything else is refused. Input may
 * arrive in arbitrary pieces; the parsed section is bounded in commands and bytes.
 */
export class ReceivePackInspector {
  constructor({ maxCommands = 64, maxBytes = 64 * 1024 } = {}) {
    this.maxCommands = maxCommands;
    this.maxBytes = maxBytes;
    this.pending = Buffer.alloc(0);
    this.consumed = 0;
    this.stage = "commands";
    this.commands = [];
    this.capabilities = [];
    this.lines = 0;
    this.options = 0;
    this.objectLength = 40;
  }
  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    for (;;) {
      // A push of deletions only carries no pack; the caller refuses deletions with their own reason.
      if (this.stage === "complete") return { done: true, commands: this.commands, capabilities: this.capabilities };
      if (this.stage === "pack") {
        if (this.pending.length < 4) return { done: false };
        if (this.pending.subarray(0, 4).toString("latin1") !== "PACK") throw new ProxyError("pack-expected");
        return { done: true, commands: this.commands, capabilities: this.capabilities };
      }
      if (this.pending.length < 4) return { done: false };
      const header = this.pending.subarray(0, 4).toString("latin1");
      if (!/^[0-9a-f]{4}$/.test(header)) throw new ProxyError("pkt-invalid");
      const length = Number.parseInt(header, 16);
      if ((length > 0 && length < 4) || length > MAX_PKT) throw new ProxyError("pkt-invalid");
      const size = length === 0 ? 4 : length;
      if (this.consumed + size > this.maxBytes) throw new ProxyError("command-list-too-large");
      if (this.pending.length < size) return { done: false };
      const payload = this.pending.subarray(4, size);
      this.pending = this.pending.subarray(size);
      this.consumed += size;
      if (this.stage === "commands") this.command(length === 0 ? undefined : payload);
      else this.option(length === 0 ? undefined : payload);
    }
  }
  command(payload) {
    if (payload === undefined) {
      if (this.commands.length === 0) throw new ProxyError("command-list-empty");
      this.stage = this.commands.every(command => /^0+$/.test(command.newId)) ? "complete" : this.capabilities.includes("push-options") ? "options" : "pack";
      return;
    }
    if (++this.lines > this.maxCommands) throw new ProxyError("command-list-too-large");
    let text = payload.toString("latin1");
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (this.commands.length === 0) {
      if (text.startsWith("push-cert")) throw new ProxyError("signed-push-refused");
      if (text.startsWith("shallow ")) {
        if (!/^shallow (?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text)) throw new ProxyError("shallow-invalid");
        return;
      }
      const nul = text.indexOf("\0");
      if (nul < 0) throw new ProxyError("capabilities-missing");
      const capabilities = text.slice(nul + 1).split(" ").filter(Boolean);
      if (!capabilities.every(validCapability)) throw new ProxyError("capability-refused");
      this.capabilities = capabilities;
      if (capabilities.includes("object-format=sha256")) this.objectLength = 64;
      text = text.slice(0, nul);
    }
    if (text.includes("\0")) throw new ProxyError("command-invalid");
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([\x21-\x7e]+)$/.exec(text);
    if (!match || match[1].length !== this.objectLength || match[2].length !== this.objectLength) throw new ProxyError("command-invalid");
    if (!validRef(match[3], false)) throw new ProxyError("ref-invalid");
    this.commands.push({ oldId: match[1], newId: match[2], ref: match[3] });
  }
  option(payload) {
    if (payload === undefined) { this.stage = "pack"; return; }
    if (++this.options > 32) throw new ProxyError("push-options-too-many");
    let text = payload.toString("latin1");
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (!/^[\x20-\x7e]{0,1000}$/.test(text)) throw new ProxyError("push-option-invalid");
  }
}

/** Every pushed ref must be a branch (or a ref the grant names exactly), inside the grant, and never a delete. */
export function pushRefusal(commands, claims) {
  for (const command of commands) {
    if (/^0+$/.test(command.newId)) return "delete-refused";
    const exact = Array.isArray(claims.refs) && claims.refs.includes(command.ref);
    if (!command.ref.startsWith("refs/heads/") && !exact) return "ref-not-branch";
    if (!refAllowed(claims.refs, command.ref)) return "ref-not-granted";
  }
  return undefined;
}

function pktLine(bytes) {
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, "0")), bytes]);
}

/**
 * A receive-pack status report that rejects every command, so Git prints `! [remote rejected] REF (reason)` instead of
 * a bare HTTP error. Wrapped in side band 1 when the client negotiated it. Undefined when the client wants no report.
 */
export function refusalReport(commands, capabilities, reason) {
  if (!capabilities.includes("report-status") && !capabilities.includes("report-status-v2")) return undefined;
  const report = Buffer.concat([
    pktLine(Buffer.from("unpack ok\n")),
    ...commands.map(command => pktLine(Buffer.from(`ng ${command.ref} Infinite GitHub proxy: ${reason}\n`, "latin1"))),
    Buffer.from("0000"),
  ]);
  const band = capabilities.includes("side-band-64k") ? 65515 : capabilities.includes("side-band") ? 995 : 0;
  if (!band) return report;
  const packets = [];
  for (let offset = 0; offset < report.length; offset += band) packets.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + band)])));
  return Buffer.concat([...packets, Buffer.from("0000")]);
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP service.

const RESPONSE_HEADERS = ["content-type", "content-length", "content-encoding", "cache-control", "expires", "pragma", "x-github-request-id"];
const REQUEST_TYPES = { "git-upload-pack": "application/x-git-upload-pack-request", "git-receive-pack": "application/x-git-receive-pack-request" };
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?";
const GIT_PATH = new RegExp(`^/(${OWNER})/([A-Za-z0-9][A-Za-z0-9._-]{0,103})/(info/refs|git-upload-pack|git-receive-pack)$`);
const MAX_RAW_INSPECTION_BYTES = 512 * 1024;
const MAX_REQUEST_MS = 30 * 60_000;
const IDLE_MS = 120_000;

/** Parses the raw request target. Encoded characters, dot segments, doubled slashes, and unknown queries are refused. */
export function parseGitRoute(method, rawUrl) {
  if (typeof rawUrl !== "string" || /[%\\\x00-\x20\x7f]/.test(rawUrl)) return { ok: false, reason: "path-invalid" };
  const q = rawUrl.indexOf("?");
  const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const query = q < 0 ? undefined : rawUrl.slice(q + 1);
  const match = GIT_PATH.exec(path);
  if (!match) return { ok: false, reason: "path-invalid" };
  const name = match[2].toLowerCase().endsWith(".git") ? match[2].slice(0, -4) : match[2];
  const repository = `${match[1]}/${name}`;
  if (!validRepository(repository)) return { ok: false, reason: "path-invalid" };
  const base = `/${match[1]}/${name}.git`;
  if (match[3] === "info/refs") {
    if (method !== "GET" || (query !== "service=git-upload-pack" && query !== "service=git-receive-pack")) return { ok: false, reason: "request-invalid" };
    return { ok: true, repository, service: query.slice("service=".length), kind: "advertise", upstreamPath: `${base}/info/refs?${query}` };
  }
  if (method !== "POST" || query !== undefined) return { ok: false, reason: "request-invalid" };
  return { ok: true, repository, service: match[3], kind: "rpc", upstreamPath: `${base}/${match[3]}` };
}

function loopbackHost(value) {
  if (typeof value !== "string") return false;
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(value);
}

function basicGrant(header) {
  if (typeof header !== "string") return undefined;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon < 0 ? undefined : decoded.slice(colon + 1);
}

function bearerGrant(header) {
  if (typeof header !== "string") return undefined;
  return /^Bearer ([A-Za-z0-9._-]{1,4096})$/.exec(header)?.[1];
}

function agentTokenAccess(config) {
  if (!config.agentUser) return "unknown";
  try {
    const user = readFileSync("/etc/passwd", "utf8").split("\n").map(line => line.split(":")).find(fields => fields[0] === config.agentUser);
    if (!user) return "unknown";
    const uid = Number(user[2]);
    const groups = new Set([Number(user[3])]);
    for (const fields of readFileSync("/etc/group", "utf8").split("\n").map(line => line.split(":")))
      if (fields.length >= 4 && fields[3].split(",").includes(config.agentUser)) groups.add(Number(fields[2]));
    const allowed = (info, bit) => info.uid === uid ? Boolean((info.mode >> 6) & bit) : groups.has(info.gid) ? Boolean((info.mode >> 3) & bit) : Boolean(info.mode & bit);
    const directory = statSync(config.tokenDirectory);
    if (!allowed(directory, 1)) return "proxy-only";
    const files = readdirSync(config.tokenDirectory).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (files.length === 0) return groups.has(directory.gid) ? "agent-readable" : "proxy-only";
    return files.some(name => allowed(statSync(join(config.tokenDirectory, name)), 4)) ? "agent-readable" : "proxy-only";
  } catch { return "unknown"; }
}

function defaultLog(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/**
 * Creates the proxy's HTTP server (not yet listening). `options.broker` handles `POST /gh`; see createGhBroker.
 * Records are one JSON object per request with no token and no grant text.
 */
export function createGithubProxy({ config, key, log = defaultLog, now = () => Date.now(), maxConcurrent = 32, broker } = {}) {
  const tokenFor = tokenStore(config, now);
  let active = 0;
  const server = http.createServer((req, res) => {
    const record = { time: new Date(now()).toISOString(), id: randomUUID(), method: req.method };
    let logged = false;
    const done = (fields = {}) => {
      if (logged) return;
      logged = true;
      log({ ...record, ...fields });
    };
    const reply = (status, reason, extraHeaders = {}) => {
      if (!res.headersSent) {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
        res.end(`Infinite GitHub proxy: ${reason}\n`);
      } else res.destroy();
      done({ decision: status < 400 ? "allow" : "refuse", reason, status });
    };
    if (active >= maxConcurrent) { reply(503, "busy"); return; }
    active++;
    res.once("close", () => { active--; if (!logged) done({ decision: "error", reason: "connection-closed" }); });
    const deadline = setTimeout(() => { req.destroy(); res.destroy(); }, MAX_REQUEST_MS);
    deadline.unref();
    res.once("close", () => clearTimeout(deadline));
    handle(req, res, record, reply, done).catch(() => reply(500, "internal-error"));
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;
  server.timeout = IDLE_MS;
  server.maxHeadersCount = 64;

  async function handle(req, res, record, reply, done) {
    if (!loopbackHost(req.headers.host)) return reply(403, "host-refused");
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, grantKey: "loaded", tokenCache: agentTokenAccess(config) }));
      return done({ decision: "allow", reason: "health", status: 200 });
    }
    if (req.url === "/gh") {
      if (!broker) return reply(404, "path-invalid");
      if (req.method !== "POST") return reply(405, "request-invalid");
      const verified = verifyGrant(bearerGrant(req.headers.authorization), key, Math.floor(now() / 1000));
      if (!verified.ok) return reply(401, verified.reason);
      Object.assign(record, { sub: verified.claims.sub, sid: verified.claims.sid, repo: verified.claims.repo, service: "gh" });
      if (!verified.claims.ops.includes("pr")) return reply(403, "pr-not-granted");
      const token = tokenFor(verified.claims.repo);
      if (!token) return reply(403, "repository-not-covered");
      return broker(req, res, verified.claims, token, record, reply, done);
    }
    const route = parseGitRoute(req.method, req.url);
    if (!route.ok) return reply(404, route.reason);
    Object.assign(record, { repo: route.repository, service: route.service });
    const grantText = basicGrant(req.headers.authorization);
    if (grantText === undefined) return reply(401, "grant-missing", { "www-authenticate": 'Basic realm="Infinite GitHub proxy"' });
    const verified = verifyGrant(grantText, key, Math.floor(now() / 1000));
    if (!verified.ok) return reply(401, verified.reason);
    const claims = verified.claims;
    Object.assign(record, { sub: claims.sub, sid: claims.sid });
    if (claims.repo.toLowerCase() !== route.repository.toLowerCase()) return reply(403, "repository-not-granted");
    const op = route.service === "git-receive-pack" ? "push" : "fetch";
    if (!claims.ops.includes(op)) return reply(403, `${op}-not-granted`);
    if (op === "push" && !claims.refs) return reply(403, "push-not-granted");
    const token = tokenFor(route.repository);
    if (!token) return reply(403, "repository-not-covered");
    if (route.kind === "advertise") return forward(req, res, route, token, [], true, reply, done);
    if (req.headers["content-type"] !== REQUEST_TYPES[route.service]) return reply(415, "content-type-invalid");
    const encoding = req.headers["content-encoding"];
    if (encoding !== undefined && encoding !== "gzip") return reply(415, "content-encoding-invalid");
    if (op === "fetch") return forward(req, res, route, token, [], false, reply, done);
    let inspected;
    try { inspected = await inspectReceivePack(req, encoding === "gzip"); }
    catch (error) { return reply(403, error instanceof ProxyError ? error.code : "command-list-invalid"); }
    record.refs = inspected.commands.map(command => command.ref);
    const refusal = pushRefusal(inspected.commands, claims);
    if (refusal) {
      const report = refusalReport(inspected.commands, inspected.capabilities, refusal);
      if (!report) return reply(403, refusal);
      // Nothing was forwarded. The rest of the upload is read and discarded.
      if (!inspected.ended) req.resume();
      res.writeHead(200, { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-store" });
      res.end(report);
      return done({ decision: "refuse", reason: refusal, status: 200 });
    }
    return forward(req, res, route, token, inspected.raw, inspected.ended, reply, done);
  }

  /** Forwards to GitHub with the installation token. `prefix` holds body bytes already read, `ended` whether that was all. */
  function forward(req, res, route, token, prefix, ended, reply, done) {
    return new Promise(settle => {
      const target = new URL(`${config.upstream}${route.upstreamPath}`);
      const headers = {
        authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        "user-agent": typeof req.headers["user-agent"] === "string" && /^git\/[\x20-\x7e]{1,200}$/.test(req.headers["user-agent"]) ? req.headers["user-agent"] : "git/infinite-github-proxy",
        accept: typeof req.headers.accept === "string" && /^[\x20-\x7e]{1,200}$/.test(req.headers.accept) ? req.headers.accept : "*/*",
      };
      const protocol = req.headers["git-protocol"];
      if (typeof protocol === "string" && /^[A-Za-z0-9=:._-]{1,256}$/.test(protocol)) headers["git-protocol"] = protocol;
      if (route.kind === "rpc") {
        headers["content-type"] = REQUEST_TYPES[route.service];
        if (req.headers["content-encoding"] === "gzip") headers["content-encoding"] = "gzip";
        if (typeof req.headers["content-length"] === "string" && /^\d{1,15}$/.test(req.headers["content-length"])) headers["content-length"] = req.headers["content-length"];
      }
      const transport = target.protocol === "https:" ? https : http;
      const upstream = transport.request(target, { method: req.method, headers, timeout: IDLE_MS }, response => {
        const status = response.statusCode ?? 502;
        if (status >= 300 && status < 400) { response.resume(); reply(502, "upstream-redirect-refused"); return settle(); }
        if (status === 401 || status === 407) { response.resume(); reply(502, "upstream-credential-refused"); return settle(); }
        const out = {};
        for (const name of RESPONSE_HEADERS) if (response.headers[name] !== undefined) out[name] = response.headers[name];
        res.writeHead(status, out);
        response.pipe(res);
        response.once("end", () => { done({ decision: status < 400 ? "allow" : "upstream-error", reason: "forwarded", status }); settle(); });
        response.once("error", () => { res.destroy(); done({ decision: "error", reason: "upstream-aborted", status }); settle(); });
      });
      upstream.once("timeout", () => upstream.destroy(new ProxyError("upstream-timeout")));
      upstream.once("error", error => {
        if (!res.headersSent) reply(502, error instanceof ProxyError ? error.code : "upstream-unavailable");
        else { res.destroy(); done({ decision: "error", reason: "upstream-aborted" }); }
        settle();
      });
      req.once("aborted", () => upstream.destroy());
      req.once("error", () => upstream.destroy());
      for (const chunk of prefix) upstream.write(chunk);
      if (ended || route.kind === "advertise") upstream.end();
      else req.pipe(upstream);
    });
  }
  return server;
}

/** Reads the request until the command list is checked. Returns the raw bytes read so far, which are forwarded unchanged. */
function inspectReceivePack(req, gzip) {
  return new Promise((resolveInspection, reject) => {
    const inspector = new ReceivePackInspector();
    const raw = [];
    let rawBytes = 0, finished = false, ended = false;
    const gunzip = gzip ? createGunzip() : undefined;
    const stop = (error, result) => {
      if (finished) return;
      finished = true;
      req.off("data", onData);
      req.off("end", onEnd);
      gunzip?.destroy();
      if (error) { req.resume(); reject(error); }
      else { req.pause(); resolveInspection({ ...result, raw, ended }); }
    };
    const feed = data => {
      if (finished) return;
      try {
        const result = inspector.push(data);
        if (result.done) stop(undefined, result);
      } catch (error) { stop(error); }
    };
    const onData = chunk => {
      raw.push(chunk);
      rawBytes += chunk.length;
      if (rawBytes > MAX_RAW_INSPECTION_BYTES) return stop(new ProxyError("command-list-too-large"));
      if (gunzip) gunzip.write(chunk);
      else feed(chunk);
    };
    const onEnd = () => {
      ended = true;
      if (gunzip) gunzip.end();
      else stop(new ProxyError("command-list-incomplete"));
    };
    if (gunzip) {
      gunzip.on("data", feed);
      gunzip.once("error", () => stop(new ProxyError("gzip-invalid")));
      gunzip.once("end", () => stop(new ProxyError("command-list-incomplete")));
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.once("error", () => stop(new ProxyError("request-aborted")));
  });
}

// ---------------------------------------------------------------------------------------------------------------

function listen(server, config) {
  const fds = Number(process.env.LISTEN_FDS);
  if (process.env.LISTEN_PID === String(process.pid) && Number.isInteger(fds) && fds >= 1) server.listen({ fd: 3 });
  else server.listen(config.listen.port, config.listen.host);
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") throw new ProxyError("usage");
  const config = loadProxyConfig(argv[1]);
  const key = loadGrantKey(config.grantKeyFile);
  const server = createGithubProxy({ config, key });
  listen(server, config);
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`github-proxy: failed (${error instanceof ProxyError ? error.code : "unexpected"})\n`);
    process.exitCode = 1;
  });
}
