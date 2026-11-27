#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

const GRANT_VERSION = "v2";
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

export function verifyGrant(text, key, nowSeconds = Math.floor(Date.now() / 1000)) {
  const refuse = reason => ({ ok: false, reason });
  if (typeof text !== "string" || text.length === 0 || text.length > GRANT_MAX_LENGTH) return refuse("grant-malformed");
  const parts = text.split(".");
  if (parts.length !== 3) return refuse("grant-malformed");
  if (parts[0] !== GRANT_VERSION) return refuse(/^v[0-9]{1,3}$/.test(parts[0]) ? "grant-version" : "grant-malformed");
  const mac = canonicalBase64url(parts[2]);
  if (!mac || mac.length !== 32) return refuse("grant-malformed");
  const expected = createHmac("sha256", key).update(`${GRANT_VERSION}.${parts[1]}`, "utf8").digest();
  if (!timingSafeEqual(mac, expected)) return refuse("grant-signature");
  const payload = canonicalBase64url(parts[1]);
  if (!payload) return refuse("grant-malformed");
  let claims;
  try { claims = JSON.parse(payload.toString("utf8")); } catch { return refuse("grant-malformed"); }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return refuse("grant-malformed");
  const keys = Object.keys(claims).sort().join(",");
  if (keys !== (Object.hasOwn(claims, "refs") ? "exp,ops,project,refs,repo,sid,sub" : "exp,ops,project,repo,sid,sub")) return refuse("grant-fields");
  if (![claims.sub, claims.sid, claims.project].every(value => typeof value === "string" && LABEL.test(value))) return refuse("grant-fields");
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

export function refAllowed(refs, ref) {
  return Array.isArray(refs) && refs.some(pattern => pattern.endsWith("/*") ? ref.startsWith(pattern.slice(0, -1)) : ref === pattern);
}

export class ProxyError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const CONFIG_KEYS = new Set(["listen", "grantKeyFile", "tokenDirectory", "githubCli", "repositories", "agentUser", "upstream"]);

export function readTrustedFile(path, code, { otherReadable, trustedUid = 0, maxBytes = 64 * 1024 }) {
  const trusted = uid => uid === 0 || uid === trustedUid;
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw new ProxyError(`${code}-path`);
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    let info;
    try { info = lstatSync(directory); } catch { throw new ProxyError(`${code}-unavailable`); }
    if (info.isSymbolicLink() || !info.isDirectory() || !trusted(info.uid) || (info.mode & 0o022) !== 0) throw new ProxyError(`${code}-directory-permissions`);
    if (directory === "/") break;
  }
  let fd;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
  catch (error) { throw new ProxyError(error?.code === "ELOOP" ? `${code}-permissions` : `${code}-unavailable`); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !trusted(info.uid) || (info.mode & 0o022) !== 0 || (!otherReadable && (info.mode & 0o007) !== 0) || info.size > maxBytes)
      throw new ProxyError(`${code}-permissions`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

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

export function loadProxyConfig(path, { trustedUid = 0 } = {}) {
  let parsed;
  try { parsed = JSON.parse(readTrustedFile(path, "config", { otherReadable: true, trustedUid })); }
  catch (error) { throw error instanceof ProxyError ? error : new ProxyError("config-json"); }
  return validateProxyConfig(parsed);
}

export function loadGrantKey(path, { trustedUid = 0 } = {}) {
  return parseGrantKey(readTrustedFile(path, "grant-key", { otherReadable: false, trustedUid, maxBytes: 1024 }));
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

const CAPABILITY_FLAGS = new Set(["report-status", "report-status-v2", "side-band-64k", "side-band", "quiet", "atomic", "ofs-delta", "push-options"]);
const MAX_PKT = 65520;

function validCapability(token) {
  if (CAPABILITY_FLAGS.has(token)) return true;
  if (/^object-format=(?:sha1|sha256)$/.test(token)) return true;
  return /^(?:agent|session-id)=[\x21-\x7e]{1,256}$/.test(token);
}

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

const RESPONSE_HEADERS = ["content-type", "content-length", "content-encoding", "cache-control", "expires", "pragma", "x-github-request-id"];
const REQUEST_TYPES = { "git-upload-pack": "application/x-git-upload-pack-request", "git-receive-pack": "application/x-git-receive-pack-request" };
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?";
const GIT_PATH = new RegExp(`^/(${OWNER})/([A-Za-z0-9][A-Za-z0-9._-]{0,103})/(info/refs|git-upload-pack|git-receive-pack)$`);
const MAX_RAW_INSPECTION_BYTES = 512 * 1024;
const MAX_DECODED_INSPECTION_BYTES = 256 * 1024;
const MAX_REQUEST_MS = 30 * 60_000;
const IDLE_MS = 120_000;

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

export function getfaclProbe(getfacl = "/usr/bin/getfacl", { timeoutMs = 5000 } = {}) {
  return paths => new Promise(settle => {
    let child, output = 0, done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); settle(value); } };
    try { child = spawn(getfacl, ["--skip-base", "--absolute-names", "--", ...paths], { stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }); }
    catch { return settle(undefined); }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(undefined); }, timeoutMs);
    child.stdout.on("data", chunk => { output += chunk.length; if (output > 1024 * 1024) { child.kill("SIGKILL"); finish(undefined); } });
    child.once("error", () => finish(undefined));
    child.once("close", code => finish(code === 0 ? output > 0 : undefined));
  });
}

export async function agentTokenAccess(config, extendedAcl) {
  if (!config.agentUser) return "unknown";
  let verdict, paths;
  try {
    const user = readFileSync("/etc/passwd", "utf8").split("\n").map(line => line.split(":")).find(fields => fields[0] === config.agentUser);
    if (!user) return "unknown";
    const uid = Number(user[2]);
    const groups = new Set([Number(user[3])]);
    for (const fields of readFileSync("/etc/group", "utf8").split("\n").map(line => line.split(":")))
      if (fields.length >= 4 && fields[3].split(",").includes(config.agentUser)) groups.add(Number(fields[2]));
    const allowed = (info, bit) => info.uid === uid ? Boolean((info.mode >> 6) & bit) : groups.has(info.gid) ? Boolean((info.mode >> 3) & bit) : Boolean(info.mode & bit);
    const directory = lstatSync(config.tokenDirectory);
    if (!directory.isDirectory()) return "unknown";
    const entries = readdirSync(config.tokenDirectory);
    const files = entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    if (allowed(directory, 1) && (files.length === 0 ? groups.has(directory.gid) : files.some(name => allowed(lstatSync(join(config.tokenDirectory, name)), 4))))
      return "agent-readable";
    verdict = "proxy-only";
    paths = [config.tokenDirectory, ...entries.map(name => join(config.tokenDirectory, name))];
  } catch { return "unknown"; }
  for (let index = 0; index < paths.length; index += 200) {
    const acl = await extendedAcl(paths.slice(index, index + 200));
    if (acl !== false) return "unknown";
  }
  return verdict;
}

function defaultLog(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function createGithubProxy({ config, key, log = defaultLog, now = () => Date.now(), maxConcurrent = 32, broker, extendedAcl = getfaclProbe() } = {}) {
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
    let holders = 1;
    const release = () => { if (--holders === 0) active--; };
    const hold = () => {
      holders++;
      let released = false;
      return () => { if (!released) { released = true; release(); } };
    };
    res.once("close", () => { release(); if (!logged) done({ decision: "error", reason: "connection-closed" }); });
    const deadline = setTimeout(() => { req.destroy(); res.destroy(); }, MAX_REQUEST_MS);
    deadline.unref();
    res.once("close", () => clearTimeout(deadline));
    handle(req, res, record, reply, done, hold).catch(() => reply(500, "internal-error"));
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;
  server.timeout = IDLE_MS;
  server.maxHeadersCount = 64;

  async function handle(req, res, record, reply, done, hold) {
    if (!loopbackHost(req.headers.host)) return reply(403, "host-refused");
    if (req.method === "GET" && req.url === "/health") {
      const tokenCache = await agentTokenAccess(config, extendedAcl);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, grantKey: "loaded", tokenCache }));
      return done({ decision: "allow", reason: "health", status: 200 });
    }
    if (req.url === "/gh") {
      if (!broker) return reply(404, "path-invalid");
      if (req.method !== "POST") return reply(405, "request-invalid");
      const verified = verifyGrant(bearerGrant(req.headers.authorization), key, Math.floor(now() / 1000));
      if (!verified.ok) return reply(401, verified.reason);
      Object.assign(record, { sub: verified.claims.sub, sid: verified.claims.sid, project: verified.claims.project, repo: verified.claims.repo, service: "gh" });
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
    Object.assign(record, { sub: claims.sub, sid: claims.sid, project: claims.project });
    if (claims.repo.toLowerCase() !== route.repository.toLowerCase()) return reply(403, "repository-not-granted");
    const op = route.service === "git-receive-pack" ? "push" : "fetch";
    if (!claims.ops.includes(op)) return reply(403, `${op}-not-granted`);
    if (op === "push" && !claims.refs) return reply(403, "push-not-granted");
    const token = tokenFor(route.repository);
    if (!token) return reply(403, "repository-not-covered");
    if (route.kind === "advertise") return forward(req, res, route, token, [], true, reply, done, hold);
    if (req.headers["content-type"] !== REQUEST_TYPES[route.service]) return reply(415, "content-type-invalid");
    const encoding = req.headers["content-encoding"];
    if (encoding !== undefined && encoding !== "gzip") return reply(415, "content-encoding-invalid");
    if (op === "fetch") return forward(req, res, route, token, [], false, reply, done, hold);
    let inspected;
    try { inspected = await inspectReceivePack(req, encoding === "gzip"); }
    catch (error) { return reply(403, error instanceof ProxyError ? error.code : "command-list-invalid"); }
    record.refs = inspected.commands.map(command => command.ref);
    const refusal = pushRefusal(inspected.commands, claims);
    if (refusal) {
      const report = refusalReport(inspected.commands, inspected.capabilities, refusal);
      if (!report) return reply(403, refusal);
      if (!inspected.ended) req.resume();
      res.writeHead(200, { "content-type": "application/x-git-receive-pack-result", "cache-control": "no-store" });
      res.end(report);
      return done({ decision: "refuse", reason: refusal, status: 200 });
    }
    return forward(req, res, route, token, inspected.raw, inspected.ended, reply, done, hold);
  }

  function forward(req, res, route, token, prefix, ended, reply, done, hold) {
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
      upstream.once("close", hold());
      upstream.once("timeout", () => upstream.destroy(new ProxyError("upstream-timeout")));
      upstream.once("error", error => {
        if (res.destroyed) return settle();
        if (!res.headersSent) reply(502, error instanceof ProxyError ? error.code : "upstream-unavailable");
        else { res.destroy(); done({ decision: "error", reason: "upstream-aborted" }); }
        settle();
      });
      req.once("aborted", () => upstream.destroy());
      req.once("error", () => upstream.destroy());
      res.once("close", () => { if (!res.writableFinished) upstream.destroy(); });
      for (const chunk of prefix) upstream.write(chunk);
      if (ended || route.kind === "advertise") upstream.end();
      else req.pipe(upstream);
    });
  }
  return server;
}

export function inspectReceivePack(req, gzip, { maxRawBytes = MAX_RAW_INSPECTION_BYTES, maxDecodedBytes = MAX_DECODED_INSPECTION_BYTES } = {}) {
  return new Promise((resolveInspection, reject) => {
    const inspector = new ReceivePackInspector();
    const raw = [];
    let rawBytes = 0, decodedBytes = 0, finished = false, ended = false;
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
      decodedBytes += data.length;
      if (decodedBytes > maxDecodedBytes) return stop(new ProxyError("command-list-too-large"));
      try {
        const result = inspector.push(data);
        if (result.done) stop(undefined, result);
      } catch (error) { stop(error); }
    };
    const onData = chunk => {
      raw.push(chunk);
      rawBytes += chunk.length;
      if (rawBytes > maxRawBytes) return stop(new ProxyError("command-list-too-large"));
      if (!gunzip) return feed(chunk);
      req.pause();
      gunzip.write(chunk, () => { if (!finished) req.resume(); });
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

const TEXT_MAX = 1024;
const BODY_MAX = 65536;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const validBranch = value => validRef(`refs/heads/${value}`, false);
const VALUES = {
  bool: undefined,
  branch: value => validBranch(value),
  text: value => value.length > 0 && value.length <= TEXT_MAX && !value.includes("\0"),
  body: value => value.length <= BODY_MAX && !value.includes("\0"),
  stdin: value => value === "-",
  fields: value => /^[A-Za-z]+(?:,[A-Za-z]+)*$/.test(value) && value.length <= 1024,
  state: value => ["open", "closed", "merged", "all"].includes(value),
  limit: value => /^[1-9][0-9]{0,3}$/.test(value),
  sha: value => SHA.test(value),
};
const REPEATABLE = new Set(["label", "reviewer", "assignee"]);
const GH_COMMANDS = {
  create: { op: "pr", selector: false, writes: true, required: ["head", "base", "title"],
    flags: { head: "branch", base: "branch", title: "text", body: "body", "body-file": "stdin", draft: "bool", label: "text", reviewer: "text", assignee: "text" },
    short: { H: "head", B: "base", t: "title", b: "body", F: "body-file", d: "draft", l: "label", r: "reviewer", a: "assignee" } },
  view: { op: "pr", selector: true, flags: { json: "fields", comments: "bool" }, short: { c: "comments" } },
  list: { op: "pr", selector: false,
    flags: { state: "state", base: "branch", head: "branch", limit: "limit", json: "fields", label: "text", author: "text", assignee: "text", search: "text", draft: "bool" },
    short: { s: "state", B: "base", H: "head", L: "limit", l: "label", A: "author", a: "assignee", S: "search", d: "draft" } },
  checks: { op: "pr", selector: true, flags: { json: "fields", required: "bool" }, short: {} },
  ready: { op: "pr", selector: true, writes: true, flags: { undo: "bool" }, short: {} },
  comment: { op: "pr", selector: true, writes: true, oneOf: ["body", "body-file"], flags: { body: "body", "body-file": "stdin" }, short: { b: "body", F: "body-file" } },
  merge: { op: "merge", selector: true, writes: true, required: ["match-head-commit"], exactlyOne: ["merge", "squash", "rebase"],
    flags: { "match-head-commit": "sha", merge: "bool", squash: "bool", rebase: "bool", subject: "text", body: "body", "body-file": "stdin" },
    short: { m: "merge", s: "squash", r: "rebase", t: "subject", b: "body", F: "body-file" } },
};

function flagLabel(token) {
  const name = token.split("=", 1)[0];
  return /^-{1,2}[A-Za-z][A-Za-z-]{0,40}$/.test(name) ? `:${name}` : "";
}

export function parseGhCommand(argv, claims) {
  if (!Array.isArray(argv) || argv.length < 2 || argv.length > 64 || !argv.every(arg => typeof arg === "string" && arg.length <= BODY_MAX && !arg.includes("\0")))
    throw new ProxyError("argv-invalid");
  if (argv[0] !== "pr" || !Object.hasOwn(GH_COMMANDS, argv[1])) throw new ProxyError("command-refused");
  const spec = GH_COMMANDS[argv[1]];
  if (!claims.ops.includes(spec.op)) throw new ProxyError(`${spec.op}-not-granted`);
  const values = new Map();
  let selector;
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--") throw new ProxyError("separator-refused");
    let name, inline;
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      name = equals < 0 ? token.slice(2) : token.slice(2, equals);
      inline = equals < 0 ? undefined : token.slice(equals + 1);
    } else if (token.startsWith("-")) {
      if (token.length !== 2) throw new ProxyError(`flag-refused${flagLabel(token)}`);
      name = token[1] === "R" ? "repo" : spec.short[token[1]];
      if (!name) throw new ProxyError(`flag-refused${flagLabel(token)}`);
    } else {
      if (!spec.selector || selector !== undefined) throw new ProxyError("argument-refused");
      if (!/^[1-9][0-9]{0,9}$/.test(token) && !validBranch(token)) throw new ProxyError("selector-invalid");
      selector = token;
      continue;
    }
    const kind = name === "repo" ? "text" : Object.hasOwn(spec.flags, name) ? spec.flags[name] : undefined;
    if (kind === undefined) throw new ProxyError(`flag-refused${flagLabel(token)}`);
    let value = true;
    if (kind === "bool") {
      if (inline !== undefined) throw new ProxyError(`flag-value-refused${flagLabel(token)}`);
    } else {
      if (inline !== undefined) value = inline;
      else {
        value = argv[++index];
        if (value === undefined || /^--?[A-Za-z]/.test(value)) throw new ProxyError(`flag-value-missing${flagLabel(token)}`);
      }
      if (!VALUES[kind](value)) throw new ProxyError(`flag-value-refused${flagLabel(token)}`);
    }
    if (name === "repo") {
      if (value.toLowerCase().replace(/\.git$/, "") !== claims.repo.toLowerCase()) throw new ProxyError("repository-not-granted");
      continue;
    }
    if (values.has(name) && !REPEATABLE.has(name)) throw new ProxyError(`flag-repeated${flagLabel(token)}`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  for (const name of spec.required ?? []) if (!values.has(name)) throw new ProxyError(`flag-required:--${name}`);
  if (spec.exactlyOne && spec.exactlyOne.filter(name => values.has(name)).length !== 1) throw new ProxyError(`flag-required:--${spec.exactlyOne.join("|--")}`);
  if (spec.oneOf && spec.oneOf.filter(name => values.has(name)).length !== 1) throw new ProxyError(`flag-required:--${spec.oneOf.join("|--")}`);
  if (values.has("body") && values.has("body-file")) throw new ProxyError("body-ambiguous");
  if (spec.selector && selector === undefined) throw new ProxyError("selector-required");
  if (spec.writes && argv[1] === "create" && !refAllowed(claims.refs, `refs/heads/${values.get("head")[0]}`)) throw new ProxyError("head-not-granted");
  const args = ["pr", argv[1], ...(selector === undefined ? [] : [selector])];
  for (const [name, list] of values) for (const value of list) args.push(value === true ? `--${name}` : `--${name}=${value}`);
  args.push(`--repo=${claims.repo}`);
  return { args, stdin: values.has("body-file"), resolve: spec.writes === true && spec.selector };
}

async function resolvePullRequest(githubCli, parsed, claims, token) {
  const lookup = await runGh(githubCli, ["pr", "view", parsed.args[2], "--json=number,headRefName,isCrossRepository", `--repo=${claims.repo}`], undefined, token);
  let pr;
  try { pr = lookup.code === 0 && !lookup.truncated ? JSON.parse(lookup.stdout) : undefined; } catch { pr = undefined; }
  if (!pr || typeof pr !== "object" || !Number.isSafeInteger(pr.number) || pr.number < 1 || typeof pr.headRefName !== "string" || typeof pr.isCrossRepository !== "boolean")
    return "pull-request-unresolved";
  if (pr.isCrossRepository) return "head-not-granted:other-repository";
  if (!validBranch(pr.headRefName) || !refAllowed(claims.refs, `refs/heads/${pr.headRefName}`)) return "head-not-granted";
  parsed.args[2] = String(pr.number);
  return undefined;
}

const GH_OUTPUT_MAX = 1024 * 1024;
const GH_TIMEOUT_MS = 60_000;

function runGh(githubCli, args, stdin, token) {
  return new Promise(settle => {
    const directory = mkdtempSync(join(tmpdir(), "infinite-gh-"));
    const env = {
      PATH: "/usr/local/bin:/usr/bin:/bin", HOME: directory, GH_CONFIG_DIR: join(directory, "gh"),
      XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_STATE_HOME: directory, XDG_DATA_HOME: directory,
      GH_TOKEN: token, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_SPINNER_DISABLED: "1", NO_COLOR: "1", CLICOLOR: "0", GH_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", LANG: "C.UTF-8",
      GH_EDITOR: "/bin/false", EDITOR: "/bin/false", VISUAL: "/bin/false", GH_BROWSER: "/bin/false", BROWSER: "/bin/false",
    };
    let child;
    try { child = spawn(githubCli, args, { cwd: directory, env, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true }); }
    catch { rmSync(directory, { recursive: true, force: true }); return settle({ code: 127, stdout: "", stderr: "gh could not be started.\n", truncated: false }); }
    const output = { stdout: [], stderr: [], bytes: { stdout: 0, stderr: 0 } };
    let truncated = false, timedOut = false;
    const collect = stream => chunk => {
      const room = GH_OUTPUT_MAX - output.bytes[stream];
      if (room <= 0) { truncated = true; return; }
      if (chunk.length > room) truncated = true;
      const kept = chunk.subarray(0, room);
      output[stream].push(kept);
      output.bytes[stream] += kept.length;
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, GH_TIMEOUT_MS);
    if (stdin !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(stdin, "utf8"); }
    let finished = false;
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rmSync(directory, { recursive: true, force: true });
      const redact = parts => Buffer.concat(parts).toString("utf8").split(token).join("[redacted]");
      settle({ code, stdout: redact(output.stdout), stderr: `${redact(output.stderr)}${timedOut ? "\nInfinite GitHub proxy: gh timed out.\n" : ""}`, truncated });
    };
    child.once("error", () => finish(127));
    child.once("close", (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}

function readJsonBody(req, max) {
  return new Promise((settle, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > max) { req.destroy(); return reject(new ProxyError("request-too-large")); }
      chunks.push(chunk);
    });
    req.once("end", () => {
      try { settle(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new ProxyError("request-invalid")); }
    });
    req.once("error", () => reject(new ProxyError("request-aborted")));
  });
}

export function createGhBroker(config, { maxConcurrent = 4 } = {}) {
  let running = 0;
  return async (req, res, claims, token, record, reply, done) => {
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(String(req.headers["content-type"] ?? ""))) return reply(415, "content-type-invalid");
    let body;
    try { body = await readJsonBody(req, 512 * 1024); } catch (error) { return reply(400, error.code ?? "request-invalid"); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "argv" && key !== "stdin") ||
      (body.stdin !== undefined && (typeof body.stdin !== "string" || Buffer.byteLength(body.stdin) > BODY_MAX))) return reply(400, "request-invalid");
    let parsed;
    try { parsed = parseGhCommand(body.argv, claims); } catch (error) { return reply(403, error instanceof ProxyError ? error.code : "argv-invalid"); }
    record.command = `pr ${parsed.args[1]}`;
    if (body.stdin !== undefined && !parsed.stdin) return reply(403, "stdin-unused");
    if (running >= maxConcurrent) return reply(503, "busy");
    running++;
    let result;
    try {
      const refusal = parsed.resolve ? await resolvePullRequest(config.githubCli, parsed, claims, token) : undefined;
      if (refusal) return reply(403, refusal);
      result = await runGh(config.githubCli, parsed.args, parsed.stdin ? body.stdin ?? "" : undefined, token);
    } finally { running--; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(result));
    done({ decision: "allow", reason: "ran", status: 200, exitCode: result.code });
  };
}

function listen(server, config) {
  const fds = Number(process.env.LISTEN_FDS);
  if (process.env.LISTEN_PID === String(process.pid) && Number.isInteger(fds) && fds >= 1) server.listen({ fd: 3 });
  else server.listen(config.listen.port, config.listen.host);
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") throw new ProxyError("usage");
  const config = loadProxyConfig(argv[1]);
  const key = loadGrantKey(config.grantKeyFile);
  const server = createGithubProxy({ config, key, broker: createGhBroker(config) });
  listen(server, config);
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`github-proxy: failed (${error instanceof ProxyError ? error.code : "unexpected"})\n`);
    process.exitCode = 1;
  });
}
