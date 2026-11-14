#!/usr/bin/env node
// Infinite egress proxy. Agent sessions on the Ubuntu host reach the network through it.
// Node standard library only. It never terminates TLS: it sees host names and ports, never content.
// Deployment, policy, and limits: deploy/ubuntu/egress.md.
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect, isIPv4, isIPv6 } from "node:net";
import { lookup } from "node:dns/promises";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The host mints credentials in this format (packages/host/src/egress.ts); both sides must agree.
const CREDENTIAL_CONTEXT = "infinite-egress/v1";
const MAX_CREDENTIAL_LIFETIME_SECONDS = 31 * 24 * 60 * 60;
const PROJECT_LABEL = /^(?:_host|_none|[a-z0-9-]{1,80})$/;
const CREDENTIAL = /^(_host|_none|[a-z0-9-]{1,80})\.([A-Za-z0-9-]{1,64}):v1\.([1-9][0-9]{0,11})\.([A-Za-z0-9_-]{43})$/;
const UNAUTHENTICATED = "_unauthenticated";
const DECISIONS = ["allowed", "would-deny", "refused", "unauthenticated"];
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_SUMMARY_BYTES = 16 * 1024 * 1024;
const KEY_BYTES = 32;

export const DEFAULT_LIMITS = Object.freeze({
  connectTimeoutMs: 10_000,
  dnsTimeoutMs: 5_000,
  idleTimeoutMs: 600_000,
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 300_000,
  maxHeaderBytes: 8 * 1024,
  maxConnections: 1024,
  maxTunnels: 512,
  maxTunnelsPerSession: 64,
  summaryIntervalMs: 30_000,
});
const LIMIT_BOUNDS = Object.freeze({
  connectTimeoutMs: [100, 120_000],
  dnsTimeoutMs: [100, 60_000],
  idleTimeoutMs: [1_000, 86_400_000],
  headersTimeoutMs: [1_000, 120_000],
  requestTimeoutMs: [1_000, 3_600_000],
  maxHeaderBytes: [1_024, 65_536],
  maxConnections: [1, 65_536],
  maxTunnels: [1, 65_536],
  maxTunnelsPerSession: [1, 65_536],
  summaryIntervalMs: [10, 3_600_000],
});

class EgressError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new EgressError(code);
}

const errorCode = (error, fallback) => (error instanceof EgressError ? error.code : fallback);

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// ---------------------------------------------------------------------------
// Credentials

export function credentialMac(key, project, session, expires) {
  return createHmac("sha256", key).update(`${CREDENTIAL_CONTEXT}\n${project}\n${session}\n${expires}`, "utf8").digest();
}

/**
 * Checks a `Proxy-Authorization` header statelessly. The user name is `PROJECT.SESSION`; the password is
 * `v1.EXPIRES.MAC`, where MAC is HMAC-SHA256 over the context, project, session, and expiry in Unix seconds.
 */
export function verifyProxyAuthorization(header, key, nowMs = Date.now()) {
  if (header === undefined) return { ok: false, reason: "missing" };
  if (typeof header !== "string" || header.length > 512) return { ok: false, reason: "malformed" };
  const match = /^Basic ([A-Za-z0-9+/]{4,400}={0,2})$/i.exec(header);
  if (!match) return { ok: false, reason: "malformed" };
  const parts = CREDENTIAL.exec(Buffer.from(match[1], "base64").toString("latin1"));
  if (!parts) return { ok: false, reason: "malformed" };
  const [, project, session, expires, mac] = parts;
  const given = Buffer.from(mac, "base64url");
  const expected = credentialMac(key, project, session, expires);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad-credential" };
  const nowSeconds = Math.floor(nowMs / 1000);
  const expiresAt = Number(expires);
  if (expiresAt <= nowSeconds) return { ok: false, reason: "expired" };
  // Only the host mints credentials; a lifetime past the host's maximum is not one it made.
  if (expiresAt > nowSeconds + MAX_CREDENTIAL_LIFETIME_SECONDS) return { ok: false, reason: "bad-credential" };
  return { ok: true, project, session };
}

// ---------------------------------------------------------------------------
// Hosts, ports, and addresses

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?";
const NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

function ipv4Part(part) {
  if (/^0x[0-9a-f]*$/.test(part)) return part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part.slice(1), 8);
  if (/^(?:0|[1-9][0-9]*)$/.test(part)) return Number(part);
  return undefined;
}

/** The dotted form of an IPv4 address written as most resolvers read it: decimal, octal, hex, or shortened. */
export function legacyIPv4(host) {
  const parts = host.split(".");
  if (parts.length > 4) return undefined;
  const numbers = parts.map(ipv4Part);
  if (numbers.some(number => number === undefined || !Number.isFinite(number))) return undefined;
  const last = numbers.pop();
  if (numbers.some(number => number > 255)) return undefined;
  if (last >= 256 ** (4 - numbers.length)) return undefined;
  const value = numbers.reduce((sum, number, index) => sum + number * 256 ** (3 - index), last);
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

/** Eight 16-bit groups of an IPv6 address, or undefined. Zone identifiers are refused. */
export function ipv6Groups(text) {
  if (typeof text !== "string" || text.length > 45 || text.includes("%") || !isIPv6(text)) return undefined;
  let source = text;
  const lastColon = source.lastIndexOf(":");
  const tail = source.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return undefined;
    const octets = tail.split(".").map(Number);
    source = `${source.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const parse = value => (value === "" ? [] : value.split(":").map(group => (/^[0-9a-fA-F]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN)));
  let groups;
  if (halves.length === 2) {
    const head = parse(halves[0]);
    const rest = parse(halves[1]);
    if (head.length + rest.length > 7) return undefined;
    groups = [...head, ...new Array(8 - head.length - rest.length).fill(0), ...rest];
  } else groups = parse(source);
  if (groups.length !== 8 || groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) return undefined;
  return groups;
}

/** RFC 5952 text for eight groups. */
export function formatIPv6(groups) {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < 8;) {
    if (groups[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < 8 && groups[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  const hex = groups.map(group => group.toString(16));
  if (bestStart < 0) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

/** A host as the proxy compares and resolves it: `{ kind: "name" | "ipv4" | "ipv6", host }`, or undefined. */
export function normalizeHost(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256 || !PRINTABLE_ASCII.test(raw)) return undefined;
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) return undefined;
    const groups = ipv6Groups(raw.slice(1, -1));
    return groups ? { kind: "ipv6", host: formatIPv6(groups) } : undefined;
  }
  let host = raw.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253 || !NAME.test(host) || host.split(".").some(label => label.length > 63)) return undefined;
  // A name whose last label is a number is an IPv4 address to resolvers; one that is not a valid address is refused.
  if (/^(?:0x[0-9a-f]*|[0-9]+)$/.test(host.split(".").at(-1))) {
    const address = legacyIPv4(host);
    return address ? { kind: "ipv4", host: address } : undefined;
  }
  return { kind: "name", host };
}

/** The host as it appears in policy entries, records, and the summary: IPv6 in brackets. */
export function hostKey(target) {
  return target.kind === "ipv6" ? `[${target.host}]` : target.host;
}

/**
 * Parses `host:port` (authority form, no user information). Without a port, `defaultPort` applies, or the parse
 * fails when there is none. Ports have no leading zeros.
 */
export function parseAuthority(text, defaultPort) {
  if (typeof text !== "string" || text.length === 0 || text.length > 300 || !PRINTABLE_ASCII.test(text)) return undefined;
  if (/[@%\\/?#,;"'<>`{}|^]/.test(text)) return undefined;
  let hostText;
  let portText;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return undefined;
    hostText = text.slice(0, close + 1);
    const rest = text.slice(close + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return undefined;
      portText = rest.slice(1);
    }
  } else {
    const colon = text.indexOf(":");
    if (colon < 0) hostText = text;
    else {
      if (text.indexOf(":", colon + 1) >= 0) return undefined;
      hostText = text.slice(0, colon);
      portText = text.slice(colon + 1);
    }
  }
  let port;
  if (portText === undefined) {
    if (defaultPort === undefined) return undefined;
    port = defaultPort;
  } else {
    if (!/^[1-9][0-9]{0,4}$/.test(portText)) return undefined;
    port = Number(portText);
    if (port > 65535) return undefined;
  }
  const host = normalizeHost(hostText);
  return host ? { ...host, port } : undefined;
}

function ipv4Number(text) {
  const octets = text.split(".").map(Number);
  return ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
}

const IPV4_REFUSED = [
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "shared"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "reserved"],
  ["192.0.2.0", 24, "reserved"],
  ["192.88.99.0", 24, "reserved"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "reserved"],
  ["198.51.100.0", 24, "reserved"],
  ["203.0.113.0", 24, "reserved"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
].map(([base, bits, label]) => ({ base: ipv4Number(base), mask: (~0 << (32 - bits)) >>> 0, label }));

function classifyIPv4Number(value) {
  for (const range of IPV4_REFUSED) if (((value & range.mask) >>> 0) === range.base) return range.label;
  return undefined;
}

function classifyIPv6(groups) {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  // An address that carries an IPv4 address is refused; the class names what it carries when that is refused too.
  const carried = () => classifyIPv4Number(((g6 << 16) >>> 0) + g7) ?? "reserved";
  if (groups.every(group => group === 0)) return "unspecified";
  if (groups.slice(0, 7).every(group => group === 0) && g7 === 1) return "loopback";
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && ((g4 === 0 && (g5 === 0 || g5 === 0xffff)) || (g4 === 0xffff && g5 === 0))) return carried();
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return carried();
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  if ((g0 & 0xfe00) === 0xfc00) return "private";
  // Outside global unicast (2000::/3), and the special blocks inside it, nothing is reachable on purpose.
  if ((g0 & 0xe000) !== 0x2000) return "reserved";
  if (g0 === 0x2001 && g1 < 0x0200) return "reserved"; // IETF protocol assignments: Teredo, benchmarking, ORCHID
  if (g0 === 0x2001 && g1 === 0x0db8) return "reserved"; // documentation
  if (g0 === 0x2002) return "reserved"; // 6to4 carries an IPv4 address
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return "reserved"; // documentation
  return undefined;
}

/** Undefined for an address the proxy may connect to; otherwise the refused class. */
export function classifyAddress(address) {
  if (typeof address !== "string") return "invalid";
  if (isIPv4(address)) return classifyIPv4Number(ipv4Number(address));
  const groups = ipv6Groups(address);
  return groups ? classifyIPv6(groups) : "invalid";
}

function canonicalAddress(address) {
  if (isIPv4(address)) return { address, family: 4 };
  const groups = ipv6Groups(address);
  return groups ? { address: formatIPv6(groups), family: 6 } : undefined;
}

// ---------------------------------------------------------------------------
// Policy

function hostRules(list, code) {
  if (!Array.isArray(list) || list.length > 5000) fail(code);
  const exact = new Set();
  const suffixes = [];
  for (const entry of list) {
    if (typeof entry !== "string") fail(code);
    if (entry.startsWith("*.")) {
      const suffix = normalizeHost(entry.slice(2));
      // A wildcard covers subdomains of a name with at least two labels, never a top-level domain or an address.
      if (!suffix || suffix.kind !== "name" || !suffix.host.includes(".")) fail(code);
      suffixes.push(suffix.host);
    } else {
      const host = normalizeHost(entry);
      if (!host) fail(code);
      exact.add(hostKey(host));
    }
  }
  return Object.freeze({ exact, suffixes: Object.freeze(suffixes) });
}

/** Validates a parsed policy document. Throws an EgressError whose code names the first problem. */
export function validatePolicy(input) {
  if (!plainObject(input)) fail("policy-shape");
  const allowed = ["mode", "ports", "allow", "projects", "allowPrivate"];
  if (Object.keys(input).some(key => !allowed.includes(key)) || !Object.hasOwn(input, "mode") || !Object.hasOwn(input, "allow")) fail("policy-shape");
  if (input.mode !== "observe" && input.mode !== "enforce") fail("policy-mode");
  const ports = input.ports ?? [443, 80];
  if (!Array.isArray(ports) || ports.length === 0 || ports.length > 64 || ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) fail("policy-ports");
  const allow = hostRules(input.allow, "policy-allow");
  const projects = new Map();
  if (input.projects !== undefined) {
    if (!plainObject(input.projects) || Object.keys(input.projects).length > 500) fail("policy-projects");
    for (const [id, value] of Object.entries(input.projects)) {
      if (!PROJECT_LABEL.test(id) || !plainObject(value) || Object.keys(value).some(key => key !== "allow") || !Object.hasOwn(value, "allow")) fail("policy-projects");
      projects.set(id, hostRules(value.allow, "policy-projects"));
    }
  }
  const allowPrivate = new Set();
  if (input.allowPrivate !== undefined) {
    if (!Array.isArray(input.allowPrivate) || input.allowPrivate.length > 200) fail("policy-allow-private");
    for (const entry of input.allowPrivate) {
      const target = parseAuthority(entry, undefined);
      if (!target) fail("policy-allow-private");
      allowPrivate.add(`${hostKey(target)}:${target.port}`);
    }
  }
  return Object.freeze({ mode: input.mode, ports: new Set(ports), allow, projects, allowPrivate });
}

function listedIn(rules, target) {
  if (!rules) return false;
  if (rules.exact.has(hostKey(target))) return true;
  return target.kind === "name" && rules.suffixes.some(suffix => target.host.endsWith(`.${suffix}`));
}

// ---------------------------------------------------------------------------
// Summary

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SUMMARY_HOST = /^(?:-|[a-z0-9._:\[\]-]{1,260})$/;
const SUMMARY_PROJECT = /^(?:_unauthenticated|_host|_none|[a-z0-9-]{1,80})$/;

function addCount(counts, decision, amount = 1) {
  counts[decision] = (counts[decision] ?? 0) + amount;
}

function validCounts(value) {
  return plainObject(value) && Object.entries(value).every(([decision, count]) => DECISIONS.includes(decision) && Number.isSafeInteger(count) && count >= 0);
}

/** Per day, per project, per host: counts by decision. Bounded in days and in host entries per day. */
export class EgressSummary {
  constructor({ maxDays = 14, maxHostsPerDay = 2000 } = {}) {
    this.maxDays = maxDays;
    this.maxHostsPerDay = maxHostsPerDay;
    this.days = new Map();
  }

  add(day, project, host, decision) {
    if (!DAY.test(day) || !DECISIONS.includes(decision)) return;
    let entry = this.days.get(day);
    if (!entry) {
      const known = [...this.days.keys()].sort();
      if (known.length >= this.maxDays && day < known[0]) return;
      entry = { projects: new Map(), hosts: 0, dropped: {} };
      this.days.set(day, entry);
      for (const old of [...this.days.keys()].sort().slice(0, Math.max(0, this.days.size - this.maxDays))) this.days.delete(old);
    }
    let hosts = entry.projects.get(project);
    let counts = hosts?.get(host);
    if (!counts) {
      if (entry.hosts >= this.maxHostsPerDay) {
        addCount(entry.dropped, decision);
        return;
      }
      if (!hosts) {
        hosts = new Map();
        entry.projects.set(project, hosts);
      }
      counts = {};
      hosts.set(host, counts);
      entry.hosts += 1;
    }
    addCount(counts, decision);
  }

  toJSON() {
    const days = {};
    for (const day of [...this.days.keys()].sort()) {
      const entry = this.days.get(day);
      const projects = {};
      for (const [project, hosts] of [...entry.projects].sort(([a], [b]) => a.localeCompare(b))) {
        projects[project] = Object.fromEntries([...hosts].sort(([a], [b]) => a.localeCompare(b)).map(([host, counts]) => [host, { ...counts }]));
      }
      days[day] = { projects, dropped: { ...entry.dropped } };
    }
    return days;
  }

  /** Rebuilds a summary from `toJSON` output, within this summary's bounds; throws on anything else. */
  static from(days, options) {
    const summary = new EgressSummary(options);
    if (!plainObject(days) || Object.keys(days).some(day => !DAY.test(day))) fail("summary-shape");
    for (const day of Object.keys(days).sort().slice(-summary.maxDays)) {
      const entry = days[day];
      if (!plainObject(entry) || !plainObject(entry.projects) || !validCounts(entry.dropped)) fail("summary-shape");
      const restored = { projects: new Map(), hosts: 0, dropped: { ...entry.dropped } };
      for (const [project, hosts] of Object.entries(entry.projects)) {
        if (!SUMMARY_PROJECT.test(project) || !plainObject(hosts)) fail("summary-shape");
        const kept = new Map();
        for (const [host, counts] of Object.entries(hosts)) {
          if (!SUMMARY_HOST.test(host) || !validCounts(counts)) fail("summary-shape");
          if (restored.hosts >= summary.maxHostsPerDay) {
            for (const [decision, count] of Object.entries(counts)) addCount(restored.dropped, decision, count);
            continue;
          }
          kept.set(host, { ...counts });
          restored.hosts += 1;
        }
        if (kept.size > 0) restored.projects.set(project, kept);
      }
      summary.days.set(day, restored);
    }
    return summary;
  }
}

// ---------------------------------------------------------------------------
// Files

const TRUSTED_OWNERS = new Set([0, typeof process.getuid === "function" ? process.getuid() : 0]);

/** Reads a regular file (no symlink) owned by root or this account, refusing the mode bits in `forbidden`. */
async function readChecked(path, label, maxBytes, forbidden) {
  let before;
  try {
    before = await lstat(path);
  } catch {
    fail(`${label}-unavailable`);
  }
  if (!before.isFile()) fail(`${label}-not-regular-file`);
  if (!TRUSTED_OWNERS.has(before.uid)) fail(`${label}-owner`);
  if ((before.mode & forbidden) !== 0) fail(`${label}-permissions`);
  if (before.size > maxBytes) fail(`${label}-too-large`);
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || (after.mode & forbidden) !== 0 || after.size > maxBytes) fail(`${label}-changed`);
    const data = await handle.readFile();
    if (data.length > maxBytes) fail(`${label}-too-large`);
    return data;
  } catch (error) {
    if (error instanceof EgressError) throw error;
    fail(`${label}-unavailable`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The shared HMAC key: exactly 32 bytes, no access for other users, no group write. */
export async function readKey(path) {
  const key = await readChecked(path, "key", KEY_BYTES, 0o027);
  if (key.length !== KEY_BYTES) fail("key-length");
  return key;
}

async function readPolicyFile(path) {
  const raw = await readChecked(path, "policy", MAX_POLICY_BYTES, 0o022);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    fail("policy-json");
  }
  return validatePolicy(parsed);
}

async function writeAtomically(path, text) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o640);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function canonicalPath(value, code) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) fail(code);
  return value;
}

/** The proxy's own configuration, read once at start. */
export async function readProxyConfig(path) {
  const raw = await readChecked(canonicalPath(resolve(path), "config-path"), "config", MAX_CONFIG_BYTES, 0o022);
  let input;
  try {
    input = JSON.parse(raw.toString("utf8"));
  } catch {
    fail("config-json");
  }
  const keys = ["listen", "keyFile", "policyFile", "summaryFile", "limits"];
  if (!plainObject(input) || Object.keys(input).some(key => !keys.includes(key)) || ["listen", "keyFile", "policyFile"].some(key => !Object.hasOwn(input, key))) fail("config-shape");
  if (!plainObject(input.listen) || Object.keys(input.listen).some(key => key !== "host" && key !== "port")) fail("config-listen");
  const { host, port } = input.listen;
  if (typeof host !== "string" || !(isIPv4(host) || isIPv6(host)) || classifyAddress(host) !== "loopback") fail("config-listen");
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("config-listen");
  const limits = { ...DEFAULT_LIMITS };
  if (input.limits !== undefined) {
    if (!plainObject(input.limits)) fail("config-limits");
    for (const [name, value] of Object.entries(input.limits)) {
      const bounds = LIMIT_BOUNDS[name];
      if (!bounds || !Number.isInteger(value) || value < bounds[0] || value > bounds[1]) fail("config-limits");
      limits[name] = value;
    }
  }
  if (limits.requestTimeoutMs < limits.headersTimeoutMs) fail("config-limits");
  return {
    listen: { host, port },
    keyFile: canonicalPath(input.keyFile, "config-key-file"),
    policyFile: canonicalPath(input.policyFile, "config-policy-file"),
    ...(input.summaryFile !== undefined ? { summaryFile: canonicalPath(input.summaryFile, "config-summary-file") } : {}),
    limits: Object.freeze(limits),
  };
}

// ---------------------------------------------------------------------------
// The proxy

const STATUS_TEXT = {
  400: "Bad Request",
  403: "Forbidden",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  429: "Too Many Requests",
  431: "Request Header Fields Too Large",
  501: "Not Implemented",
  502: "Bad Gateway",
  504: "Gateway Timeout",
};
const HOP_BY_HOP = new Set(["connection", "proxy-connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade", "expect"]);

function rawResponse(status, body, extra = "") {
  return `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n${extra}Content-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

function refusalBody(reason, entry) {
  const where = entry.host ? `${entry.hostKey}${entry.port ? `:${entry.port}` : ""}` : "the destination";
  const text = {
    missing: "Infinite egress proxy: this request carries no proxy credentials.",
    malformed: "Infinite egress proxy: the proxy credentials are not valid.",
    "bad-credential": "Infinite egress proxy: the proxy credentials are not valid.",
    expired: "Infinite egress proxy: the proxy credentials have expired. Start a new session.",
    "bad-target": "Infinite egress proxy: the destination is not a valid host and port.",
    "host-mismatch": "Infinite egress proxy: the Host header does not name the requested destination.",
    "upgrade-unsupported": "Infinite egress proxy: protocol upgrades over plain HTTP are not supported; use CONNECT.",
    "no-policy": "Infinite egress proxy has no valid policy and refuses every destination.",
    port: `Infinite egress proxy refused ${where}: the port is not allowed.`,
    "not-listed": `Infinite egress proxy refused ${where}: the host is not in the egress allowlist.`,
    "too-many-connections": "Infinite egress proxy: this session has too many open connections.",
    "dns-failed": `Infinite egress proxy could not resolve ${where}.`,
    "dns-timeout": `Infinite egress proxy could not resolve ${where} in time.`,
    "connect-failed": `Infinite egress proxy could not connect to ${where}.`,
    "connect-timeout": `Infinite egress proxy timed out connecting to ${where}.`,
  }[reason];
  if (text) return `${text}\n`;
  if (reason.startsWith("address-")) return `Infinite egress proxy refused ${where}: it resolves to a ${reason.slice(8)} address.\n`;
  return "Infinite egress proxy refused this request.\n";
}

function statusFor(reason, decision) {
  if (decision === "unauthenticated") return 407;
  if (reason === "bad-target" || reason === "host-mismatch") return 400;
  if (reason === "too-many-connections") return 429;
  if (reason === "upgrade-unsupported") return 501;
  if (reason === "connect-timeout" || reason === "dns-timeout") return 504;
  if (reason === "dns-failed" || reason === "connect-failed") return 502;
  return 403;
}

function sameAddress(actual, expected) {
  if (typeof actual !== "string") return false;
  const normalized = canonicalAddress(actual.startsWith("::ffff:") && isIPv4(actual.slice(7)) && expected.includes(".") ? actual.slice(7) : actual);
  return normalized?.address === expected;
}

function forwardedHeaders(rawHeaders, hostHeader) {
  const connectionTokens = new Set();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === "connection") for (const token of rawHeaders[index + 1].split(",")) connectionTokens.add(token.trim().toLowerCase());
  }
  // No prototype: a header named `constructor` or `__proto__` is just a header.
  const headers = Object.create(null);
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    if (HOP_BY_HOP.has(name) || connectionTokens.has(name) || name === "host") continue;
    (headers[name] ??= []).push(rawHeaders[index + 1]);
  }
  if (hostHeader !== undefined) headers.host = hostHeader;
  return headers;
}

/**
 * Creates the proxy. `resolve(host)` returns `[{ address, family }]` (default: the system resolver, every address);
 * `log(record)` receives each record (default: one JSON line on stdout); `now()` is the clock.
 */
export function createEgressProxy(options) {
  const key = options.key;
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) fail("key-length");
  const policyFile = options.policyFile;
  const summaryFile = options.summaryFile;
  const resolveName = options.resolve ?? (host => lookup(host, { all: true }));
  const emit = options.log ?? (record => process.stdout.write(`${JSON.stringify(record)}\n`));
  const clock = options.now ?? Date.now;
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...(options.limits ?? {}) });

  let policy;
  let policyLoadedAt = null;
  let policyError = null;
  let summary = new EgressSummary();
  let dirty = false;
  let writeTimer;
  let writing = Promise.resolve();
  let reloading = Promise.resolve();
  let closing = false;
  const active = new Set();
  const perSession = new Map();
  let open = 0;

  const iso = (ms = clock()) => new Date(ms).toISOString();
  const say = record => {
    try { emit(record); } catch { /* a failed log line never fails a connection */ }
  };

  function markDirty() {
    if (!summaryFile) return;
    dirty = true;
    if (writeTimer || closing) return;
    writeTimer = setTimeout(() => {
      writeTimer = undefined;
      void flush();
    }, limits.summaryIntervalMs);
    writeTimer.unref?.();
  }

  function snapshot() {
    return { schema: 1, updatedAt: iso(), mode: policy?.mode ?? null, policy: { loadedAt: policyLoadedAt, error: policyError }, days: summary.toJSON() };
  }

  /** Writes the summary now (atomically), if there is one to write. */
  function flush() {
    if (!summaryFile) return Promise.resolve();
    writing = writing.then(async () => {
      if (!dirty) return;
      dirty = false;
      try {
        await writeAtomically(summaryFile, `${JSON.stringify(snapshot())}\n`);
      } catch (error) {
        dirty = true;
        say({ time: iso(), event: "summary", status: "write-failed", error: error?.code ?? "write-failed" });
      }
    });
    return writing;
  }

  async function loadSummary() {
    if (!summaryFile) return;
    try {
      const raw = await readChecked(summaryFile, "summary", MAX_SUMMARY_BYTES, 0o022);
      const parsed = JSON.parse(raw.toString("utf8"));
      if (!plainObject(parsed) || parsed.schema !== 1) fail("summary-shape");
      summary = EgressSummary.from(parsed.days);
    } catch (error) {
      if (errorCode(error, "") !== "summary-unavailable") say({ time: iso(), event: "summary", status: "reset", error: errorCode(error, "summary-json") });
    }
  }

  /** Re-reads the policy. A policy that fails to load leaves the last good one in force. */
  function reload() {
    reloading = reloading.then(async () => {
      try {
        policy = await readPolicyFile(policyFile);
        policyLoadedAt = iso();
        policyError = null;
        say({ time: policyLoadedAt, event: "policy", status: "loaded", mode: policy.mode, allow: policy.allow.exact.size + policy.allow.suffixes.length, projects: policy.projects.size, allowPrivate: policy.allowPrivate.size });
      } catch (error) {
        policyError = errorCode(error, "policy-unavailable");
        say({ time: iso(), event: "policy", status: "rejected", error: policyError, kept: policy?.mode ?? null });
      }
      dirty = true;
      markDirty();
      return { mode: policy?.mode ?? null, error: policyError };
    });
    return reloading;
  }

  function acquire(identity) {
    const id = `${identity.project}.${identity.session}`;
    const count = perSession.get(id) ?? 0;
    if (open >= limits.maxTunnels || count >= limits.maxTunnelsPerSession) return undefined;
    open += 1;
    perSession.set(id, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      open -= 1;
      const left = (perSession.get(id) ?? 1) - 1;
      if (left > 0) perSession.set(id, left);
      else perSession.delete(id);
    };
  }

  function newEntry(kind) {
    return { kind, started: clock(), project: null, session: null, host: null, hostKey: null, port: null, address: null, decision: "refused", reason: null, bytesUp: 0, bytesDown: 0, recorded: false };
  }

  function record(entry) {
    if (entry.recorded) return;
    entry.recorded = true;
    const finished = clock();
    say({
      time: iso(entry.started), kind: entry.kind, project: entry.project, session: entry.session,
      host: entry.host, port: entry.port, address: entry.address, decision: entry.decision, reason: entry.reason,
      bytesUp: entry.bytesUp, bytesDown: entry.bytesDown, durationMs: Math.max(0, finished - entry.started),
    });
    summary.add(iso(entry.started).slice(0, 10), entry.project ?? UNAUTHENTICATED, entry.hostKey ?? "-", entry.decision);
    markDirty();
  }

  function setTarget(entry, target) {
    if (!target) return;
    entry.host = target.host;
    entry.hostKey = hostKey(target);
    entry.port = target.port;
  }

  async function resolveTarget(target) {
    if (target.kind !== "name") return [{ address: target.host, family: target.kind === "ipv4" ? 4 : 6 }];
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => resolveName(target.host)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new EgressError("dns-timeout")), limits.dnsTimeoutMs); }),
      ]);
      if (!Array.isArray(result) || result.length === 0 || result.length > 64) fail("dns-failed");
      return result.map(item => canonicalAddress(item?.address) ?? fail("dns-failed"));
    } catch (error) {
      fail(errorCode(error, "dns-failed") === "dns-timeout" ? "dns-timeout" : "dns-failed");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The policy decision for one destination. Enforce refuses an unlisted host before any lookup, so the proxy never
   * resolves a name it would refuse. Every address a name resolves to is checked; one refused address refuses the name.
   */
  async function decide(identity, target) {
    const current = policy;
    if (!current) return { refuse: true, decision: "refused", reason: "no-policy" };
    if (!current.ports.has(target.port)) return { refuse: true, decision: "refused", reason: "port" };
    const listed = listedIn(current.allow, target) || listedIn(current.projects.get(identity.project), target);
    if (!listed && current.mode === "enforce") return { refuse: true, decision: "refused", reason: "not-listed" };
    const decision = listed ? "allowed" : "would-deny";
    let addresses;
    try {
      addresses = await resolveTarget(target);
    } catch (error) {
      return { refuse: true, decision, reason: errorCode(error, "dns-failed") };
    }
    if (!current.allowPrivate.has(`${hostKey(target)}:${target.port}`)) {
      for (const { address } of addresses) {
        const refused = classifyAddress(address);
        if (refused) return { refuse: true, decision: "refused", reason: `address-${refused}` };
      }
    }
    return { refuse: false, decision, reason: listed ? "listed" : "not-listed", addresses };
  }

  /** Connects to the checked addresses in order, by address, so no second lookup can change the target. */
  function connectUpstream(addresses, port) {
    return new Promise((resolvePromise, reject) => {
      let index = 0;
      let settled = false;
      let current;
      const overall = setTimeout(() => {
        if (settled) return;
        settled = true;
        current?.destroy();
        reject(new EgressError("connect-timeout"));
      }, limits.connectTimeoutMs);
      const attempt = () => {
        if (settled) return;
        if (index >= addresses.length) {
          settled = true;
          clearTimeout(overall);
          reject(new EgressError("connect-failed"));
          return;
        }
        const { address, family } = addresses[index++];
        const socket = netConnect({ host: address, port, family, noDelay: true });
        current = socket;
        socket.once("error", () => {
          socket.destroy();
          attempt();
        });
        socket.once("connect", () => {
          if (settled) { socket.destroy(); return; }
          settled = true;
          clearTimeout(overall);
          socket.removeAllListeners("error");
          socket.on("error", () => {});
          if (!sameAddress(socket.remoteAddress, address)) {
            socket.destroy();
            reject(new EgressError("connect-failed"));
            return;
          }
          resolvePromise({ socket, address });
        });
      };
      attempt();
    });
  }

  function refuseSocket(socket, entry, decision, reason) {
    entry.decision = decision;
    entry.reason = reason;
    record(entry);
    if (socket.destroyed) return;
    const status = statusFor(reason, decision);
    const extra = status === 407 ? 'Proxy-Authenticate: Basic realm="infinite-egress"\r\n' : "";
    // Bytes the client already sent are read and dropped, never forwarded, so the close is not a reset.
    socket.resume();
    socket.end(rawResponse(status, refusalBody(reason, entry), extra));
    setTimeout(() => socket.destroy(), 1000).unref?.();
  }

  function refuseResponse(res, entry, decision, reason) {
    entry.decision = decision;
    entry.reason = reason;
    record(entry);
    if (res.headersSent || res.destroyed) { res.destroy(); return; }
    const status = statusFor(reason, decision);
    const body = refusalBody(reason, entry);
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      connection: "close",
      ...(status === 407 ? { "proxy-authenticate": 'Basic realm="infinite-egress"' } : {}),
    });
    res.end(body);
  }

  function track(socket) {
    active.add(socket);
    socket.once("close", () => active.delete(socket));
  }

  function tunnel(client, upstream, head, entry) {
    track(upstream);
    let clientClosed = false;
    let upstreamClosed = false;
    let upstreamFailed = false;
    const settle = () => {
      if (!clientClosed || !upstreamClosed) return;
      entry.bytesUp = upstream.bytesWritten;
      entry.bytesDown = upstream.bytesRead;
      record(entry);
    };
    client.on("error", () => client.destroy());
    upstream.on("error", () => { upstreamFailed = true; upstream.destroy(); });
    client.once("close", () => {
      clientClosed = true;
      upstream.destroy();
      settle();
    });
    upstream.once("close", () => {
      upstreamClosed = true;
      // A clean close lets the client read what is still queued; a failure aborts it.
      if (upstreamFailed) client.destroy();
      else {
        client.end();
        client.setTimeout(Math.min(limits.idleTimeoutMs, 30_000));
      }
      settle();
    });
    // The client already carries the idle timeout set when its CONNECT arrived.
    upstream.setTimeout(limits.idleTimeoutMs, () => upstream.destroy());
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    // Bytes the client sent after the CONNECT head, in the same packet, belong to the tunnel.
    if (head && head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  }

  async function onConnect(req, client, head) {
    const entry = newEntry("connect");
    client.on("error", () => {});
    track(client);
    client.setTimeout(limits.idleTimeoutMs, () => client.destroy());
    const target = parseAuthority(req.url, undefined);
    setTarget(entry, target);
    const auth = verifyProxyAuthorization(req.headers["proxy-authorization"], key, clock());
    if (!auth.ok) return refuseSocket(client, entry, "unauthenticated", auth.reason);
    entry.project = auth.project;
    entry.session = auth.session;
    if (!target) return refuseSocket(client, entry, "refused", "bad-target");
    const release = acquire(auth);
    if (!release) return refuseSocket(client, entry, "refused", "too-many-connections");
    client.once("close", release);
    const verdict = await decide(auth, target);
    if (verdict.refuse) return refuseSocket(client, entry, verdict.decision, verdict.reason);
    entry.decision = verdict.decision;
    entry.reason = verdict.reason;
    if (client.destroyed) { entry.reason = "client-closed"; record(entry); return; }
    let upstream;
    try {
      ({ socket: upstream, address: entry.address } = await connectUpstream(verdict.addresses, target.port));
    } catch (error) {
      return refuseSocket(client, entry, verdict.decision, errorCode(error, "connect-failed"));
    }
    if (client.destroyed || closing) {
      upstream.destroy();
      entry.reason = "client-closed";
      record(entry);
      return;
    }
    tunnel(client, upstream, head, entry);
  }

  /** Absolute-form `http://` requests. Each response closes its connection, so one connection carries one decision. */
  async function onRequest(req, res) {
    const entry = newEntry("http");
    res.shouldKeepAlive = false;
    req.on("error", () => {});
    res.on("error", () => {});
    const match = /^http:\/\/([^/?#]*)(.*)$/is.exec(req.url ?? "");
    const target = match ? parseAuthority(match[1], 80) : undefined;
    const rest = match?.[2] ?? "";
    setTarget(entry, target);
    const auth = verifyProxyAuthorization(req.headers["proxy-authorization"], key, clock());
    if (!auth.ok) return refuseResponse(res, entry, "unauthenticated", auth.reason);
    entry.project = auth.project;
    entry.session = auth.session;
    if (!target || !(rest === "" || rest.startsWith("/") || rest.startsWith("?"))) return refuseResponse(res, entry, "refused", "bad-target");
    if (req.headers.host !== undefined) {
      const named = parseAuthority(req.headers.host, 80);
      if (!named || hostKey(named) !== hostKey(target) || named.port !== target.port) return refuseResponse(res, entry, "refused", "host-mismatch");
    }
    const release = acquire(auth);
    if (!release) return refuseResponse(res, entry, "refused", "too-many-connections");
    res.once("close", release);
    const verdict = await decide(auth, target);
    if (verdict.refuse) return refuseResponse(res, entry, verdict.decision, verdict.reason);
    entry.decision = verdict.decision;
    entry.reason = verdict.reason;
    let upstream;
    try {
      ({ socket: upstream, address: entry.address } = await connectUpstream(verdict.addresses, target.port));
    } catch (error) {
      return refuseResponse(res, entry, verdict.decision, errorCode(error, "connect-failed"));
    }
    if (res.destroyed || closing) {
      upstream.destroy();
      entry.reason = "client-closed";
      record(entry);
      return;
    }
    track(upstream);
    upstream.setTimeout(limits.idleTimeoutMs, () => upstream.destroy());
    const path = rest === "" ? "/" : rest.startsWith("?") ? `/${rest}` : rest;
    const hostHeader = target.port === 80 ? hostKey(target) : `${hostKey(target)}:${target.port}`;
    const headers = Object.assign(forwardedHeaders(req.rawHeaders, hostHeader), { connection: "close" });
    let outgoing;
    try {
      // No agent: `createConnection` hands over the socket already connected to the checked address. The same
      // address is named again so that nothing could fall back to a lookup of its own.
      outgoing = httpRequest({ method: req.method, host: entry.address, port: target.port, path, headers, setHost: false, createConnection: () => upstream });
    } catch {
      upstream.destroy();
      return refuseResponse(res, entry, "refused", "bad-target");
    }
    res.once("close", () => {
      outgoing.destroy();
      upstream.destroy();
      record(entry);
    });
    outgoing.on("error", () => {
      if (!res.headersSent) refuseResponse(res, entry, verdict.decision, "connect-failed");
      else res.destroy();
    });
    outgoing.once("response", response => {
      response.on("error", () => res.destroy());
      response.on("data", chunk => { entry.bytesDown += chunk.length; });
      const responseHeaders = forwardedHeaders(response.rawHeaders, undefined);
      try {
        res.writeHead(response.statusCode ?? 502, Object.assign(responseHeaders, { connection: "close" }));
      } catch {
        res.destroy();
        return;
      }
      response.pipe(res);
    });
    req.on("data", chunk => { entry.bytesUp += chunk.length; });
    req.pipe(outgoing);
  }

  function onUpgrade(req, socket) {
    const entry = newEntry("http");
    socket.on("error", () => {});
    track(socket);
    const match = /^http:\/\/([^/?#]*)/i.exec(req.url ?? "");
    setTarget(entry, match ? parseAuthority(match[1], 80) : undefined);
    const auth = verifyProxyAuthorization(req.headers["proxy-authorization"], key, clock());
    if (!auth.ok) return refuseSocket(socket, entry, "unauthenticated", auth.reason);
    entry.project = auth.project;
    entry.session = auth.session;
    refuseSocket(socket, entry, "refused", "upgrade-unsupported");
  }

  function onClientError(error, socket) {
    const code = error?.code ?? "";
    if (!code.startsWith("HPE_") && code !== "ERR_HTTP_REQUEST_TIMEOUT") { socket.destroy(); return; }
    const entry = newEntry("http");
    const reason = code === "HPE_HEADER_OVERFLOW" ? "header-too-large" : code === "ERR_HTTP_REQUEST_TIMEOUT" ? "request-timeout" : "bad-request";
    entry.decision = "refused";
    entry.reason = reason;
    record(entry);
    if (!socket.writable) { socket.destroy(); return; }
    const status = reason === "header-too-large" ? 431 : reason === "request-timeout" ? 408 : 400;
    socket.end(rawResponse(status, "Infinite egress proxy: the request could not be read.\n"));
    setTimeout(() => socket.destroy(), 1000).unref?.();
  }

  const server = createServer({
    maxHeaderSize: limits.maxHeaderBytes,
    headersTimeout: limits.headersTimeoutMs,
    requestTimeout: limits.requestTimeoutMs,
    connectionsCheckingInterval: Math.min(5_000, limits.headersTimeoutMs),
    requireHostHeader: false,
    joinDuplicateHeaders: false,
    insecureHTTPParser: false,
  });
  server.maxHeadersCount = 64;
  server.maxConnections = limits.maxConnections;
  server.keepAliveTimeout = 5_000;
  server.on("connect", (req, socket, head) => {
    onConnect(req, socket, head).catch(() => socket.destroy());
  });
  server.on("request", (req, res) => {
    onRequest(req, res).catch(() => res.destroy());
  });
  server.on("upgrade", (req, socket) => {
    try { onUpgrade(req, socket); } catch { socket.destroy(); }
  });
  server.on("clientError", (error, socket) => {
    try { onClientError(error, socket); } catch { socket.destroy(); }
  });

  function listen(target) {
    return new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(target, () => {
        server.off("error", reject);
        const address = server.address();
        // A socket handed over by systemd is checked too: the proxy serves loopback only.
        if (!address || typeof address === "string" || classifyAddress(address.address === "::ffff:127.0.0.1" ? "127.0.0.1" : address.address) !== "loopback") {
          server.close();
          reject(new EgressError("listen-not-loopback"));
          return;
        }
        resolvePromise(address);
      });
    });
  }

  async function close() {
    closing = true;
    clearTimeout(writeTimer);
    writeTimer = undefined;
    await new Promise(resolvePromise => {
      server.close(() => resolvePromise());
      server.closeAllConnections?.();
      for (const socket of active) socket.destroy();
    });
    // Records from the connections closed above land before the last write.
    await new Promise(resolvePromise => setImmediate(resolvePromise));
    await flush();
  }

  return {
    server,
    listen,
    close,
    reload,
    flush,
    loadSummary,
    state: () => ({ mode: policy?.mode ?? null, policyError, open, sessions: perSession.size }),
  };
}

// ---------------------------------------------------------------------------
// Command line

function socketActivation() {
  const count = process.env.LISTEN_FDS;
  if (count === undefined) return undefined;
  if (process.env.LISTEN_PID !== String(process.pid) || count !== "1") fail("listen-fds");
  delete process.env.LISTEN_FDS;
  delete process.env.LISTEN_PID;
  delete process.env.LISTEN_FDNAMES;
  return { fd: 3 };
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Usage: egress-proxy.mjs --config FILE\nReload the policy with SIGHUP. See deploy/ubuntu/egress.md.");
    return;
  }
  if (argv.length !== 2 || argv[0] !== "--config") fail("usage");
  const config = await readProxyConfig(argv[1]);
  const key = await readKey(config.keyFile);
  const proxy = createEgressProxy({ key, policyFile: config.policyFile, summaryFile: config.summaryFile, limits: config.limits });
  await proxy.loadSummary();
  await proxy.reload();
  const activated = socketActivation();
  const address = await proxy.listen(activated ?? { host: config.listen.host, port: config.listen.port });
  console.log(JSON.stringify({ time: new Date().toISOString(), event: "start", listen: `${address.address}:${address.port}`, socket: activated ? "systemd" : "own" }));
  process.on("SIGHUP", () => { void proxy.reload(); });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      void proxy.close().finally(() => process.exit(0));
    });
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`egress-proxy: failed (${errorCode(error, "start-failed")})`);
    process.exit(1);
  });
}
