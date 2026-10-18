#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const permissionSet = Object.freeze({
  contents: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
  metadata: "read",
});
const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const repoPattern = /^[A-Za-z0-9_.-]{1,100}$/;

class ClientError extends Error {}

function fail(message) {
  throw new ClientError(message);
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Invalid ${name}.`);
}

function readJsonFile(path, name) {
  let info;
  try { info = lstatSync(path); } catch { fail(`${name} is unavailable.`); }
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o022) !== 0) fail(`${name} must be a regular, non-writable file.`);
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { fail(`${name} is malformed.`); }
}

function canonicalSlug(value) {
  if (typeof value !== "string" || value.trim() !== value || /[\s\\%?#:@]/u.test(value)) fail("Repository target must be OWNER/REPO.");
  const parts = value.split("/");
  if (parts.length !== 2) fail("Repository target must be OWNER/REPO.");
  let [owner, repo] = parts;
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (!ownerPattern.test(owner) || !repoPattern.test(repo) || repo === "." || repo === ".." || repo.startsWith("-") || repo.endsWith(".") || repo.toLowerCase().endsWith(".git")) fail("Repository target must be a canonical GitHub OWNER/REPO.");
  return `${owner}/${repo}`;
}

function githubUrlParts(value, { allowApiHost = false, allowPullRequest = false } = {}) {
  let url;
  try { url = new URL(value); } catch { fail("GitHub URL target is invalid."); }
  const authority = value.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u)?.[1] ?? "";
  const hostname = url.hostname.toLowerCase();
  const allowed = allowApiHost ? ["github.com", "api.github.com"] : ["github.com"];
  if (url.protocol !== "https:" || !allowed.includes(hostname) || authority.toLowerCase() !== hostname || url.username || url.password || url.port || url.search || url.hash) fail("GitHub URL must use github.com without credentials, port, query, or fragment.");
  if (url.pathname.includes("//")) fail("GitHub URL path is ambiguous.");
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.some(segment => /%/u.test(segment))) fail("Encoded GitHub URL paths are not accepted.");
  if (allowPullRequest && segments.length >= 4 && segments[2] === "pull" && /^\d+$/u.test(segments[3])) return canonicalSlug(`${segments[0]}/${segments[1]}`);
  return null;
}

function repositoryFromTarget(value) {
  if (typeof value !== "string" || value.trim() !== value || !value) fail("Repository target must be OWNER/REPO.");
  if (/^https?:\/\//iu.test(value)) {
    const repo = githubUrlParts(value);
    if (repo) return repo;
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/u);
    if (!match) fail("Repository URL target is ambiguous.");
    return canonicalSlug(`${match[1]}/${match[2]}`);
  }
  return canonicalSlug(value);
}

function repositoryFromRemote(value) {
  const scp = value.match(/^(?:git@)?github\.com:([^:]+)$/iu);
  if (scp) return canonicalSlug(scp[1]);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) {
    let url;
    try { url = new URL(value); } catch { fail("GitHub origin URL is invalid."); }
    const authority = value.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u)?.[1] ?? "";
    const host = url.hostname.toLowerCase();
    if (host !== "github.com") return null;
    if (!(["https:", "ssh:"].includes(url.protocol)) || authority.toLowerCase() !== (url.protocol === "ssh:" ? `git@${host}` : host) || url.password || url.port || url.search || url.hash) fail("GitHub origin must be a clean github.com URL without credentials, port, query, or fragment.");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) fail("GitHub origin must identify exactly OWNER/REPO.");
    return canonicalSlug(`${parts[0]}/${parts[1]}`);
  }
  return null;
}

function loadConfig(path) {
  if (typeof path !== "string" || !path) fail("Usage: --config FILE <gh|credential|status>.");
  const value = readJsonFile(path, "Client config");
  assertObject(value, "client config");
  if (Object.keys(value).some(key => !["tokenDirectory", "githubCli", "repositories"].includes(key)) || typeof value.tokenDirectory !== "string" || !value.tokenDirectory.startsWith("/") || typeof value.githubCli !== "string" || !value.githubCli.startsWith("/") || !Array.isArray(value.repositories)) fail("Client config must contain absolute tokenDirectory/githubCli paths and a repositories list.");
  const repositories = value.repositories.map(canonicalSlug);
  const seen = new Set();
  for (const repository of repositories) {
    const key = repository.toLowerCase();
    if (seen.has(key)) fail("Client config contains duplicate repositories.");
    seen.add(key);
  }
  try {
    const info = lstatSync(value.tokenDirectory);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o022) !== 0) fail("Token directory must be a non-writable, non-symlink directory.");
  } catch (error) {
    if (error instanceof ClientError) throw error;
    if (error?.code !== "ENOENT") fail("Token directory is unavailable.");
  }
  return { tokenDirectory: value.tokenDirectory, githubCli: value.githubCli, repositories };
}

function configured(config, repository) {
  return config.repositories.find(value => value.toLowerCase() === repository.toLowerCase());
}

function tokenPath(config, repository) {
  const key = createHash("sha256").update(repository.toLowerCase()).digest("hex");
  return `${config.tokenDirectory}/${key}.json`;
}

function cacheStatus(config, repository) {
  const path = tokenPath(config, repository);
  let raw;
  try { raw = readJsonFile(path, "Token cache"); }
  catch (error) {
    if (error instanceof ClientError && /unavailable/u.test(error.message)) return { state: "missing" };
    return { state: "invalid" };
  }
  try {
    assertObject(raw, "token cache");
    const allowedKeys = ["schemaVersion", "repository", "repositoryId", "installationId", "token", "expiresAt", "permissions"];
    if (Object.keys(raw).some(key => !allowedKeys.includes(key)) || allowedKeys.some(key => !Object.hasOwn(raw, key)) || raw.schemaVersion !== 1) return { state: "invalid" };
    if (typeof raw.repository !== "string" || raw.repository.toLowerCase() !== repository.toLowerCase()) return { state: "invalid" };
    const idValid = id => Number.isSafeInteger(id) && id > 0 || typeof id === "string" && /^[1-9]\d{0,19}$/u.test(id);
    if (!idValid(raw.repositoryId) || !idValid(raw.installationId)) return { state: "invalid" };
    if (typeof raw.token !== "string" || Buffer.byteLength(raw.token, "utf8") > 16384 || raw.token.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(raw.token)) return { state: "invalid" };
    if (typeof raw.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(raw.expiresAt) || !Number.isFinite(Date.parse(raw.expiresAt))) return { state: "invalid" };
    assertObject(raw.permissions, "token permissions");
    if (Object.keys(raw.permissions).length !== Object.keys(permissionSet).length || Object.entries(permissionSet).some(([key, permission]) => raw.permissions[key] !== permission)) return { state: "invalid" };
    if (Date.parse(raw.expiresAt) < Date.now() + 60_000) return { state: "expired", expiresAt: raw.expiresAt };
    return { state: "ready", token: raw.token, expiresAt: raw.expiresAt };
  } catch { return { state: "invalid" }; }
}

function failClosedCache(config, repository) {
  const state = cacheStatus(config, repository).state;
  fail(state === "expired" ? "Configured GitHub App token is expired or too close to expiry." : state === "invalid" ? "Configured GitHub App token cache is invalid." : "Configured GitHub App token is unavailable.");
}

function sameRepository(hints) {
  if (!hints.length) return null;
  const first = hints[0].repository;
  if (hints.some(hint => hint.repository.toLowerCase() !== first.toLowerCase())) fail("Conflicting GitHub repository targets.");
  return first;
}

function extractHints(args, env) {
  const hints = [];
  let unboundRepoFlag = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    let value;
    if (arg === "--repo" || arg === "-R") {
      if (!args[index + 1] || args[index + 1].startsWith("-")) { unboundRepoFlag = true; continue; }
      value = args[++index];
    } else if (arg.startsWith("--repo=")) value = arg.slice("--repo=".length);
    else if (arg.startsWith("-R") && arg.length > 2) value = arg.slice(2);
    if (value !== undefined) hints.push({ source: "repo flag", repository: repositoryFromTarget(value) });
  }
  if (env.GH_REPO) hints.push({ source: "GH_REPO", repository: repositoryFromTarget(env.GH_REPO) });

  const apiIndex = args.indexOf("api");
  for (let index = 0; index < args.length; index++) {
    if (apiIndex >= 0 && index > apiIndex) continue;
    const arg = args[index];
    if (/^https?:\/\//iu.test(arg) && /github\.com/iu.test(arg)) {
      const repo = githubUrlParts(arg, { allowPullRequest: true });
      if (repo) hints.push({ source: "pull request URL", repository: repo });
    }
  }

  if (apiIndex >= 0) {
    for (let index = apiIndex + 1; index < args.length; index++) {
      const arg = args[index];
      if (/^https?:\/\//iu.test(arg)) {
        let url;
        try { url = new URL(arg); } catch { fail("GitHub API URL is invalid."); }
        const apiPath = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/iu);
        if (apiPath) {
          const repo = githubUrlParts(arg, { allowApiHost: true });
          if (!repo) hints.push({ source: "API URL", repository: canonicalSlug(`${apiPath[1]}/${apiPath[2]}`) });
          else hints.push({ source: "API URL", repository: repo });
        } else if (url.hostname.toLowerCase() !== "api.github.com") {
          hints.push({ source: "external API URL", repository: "!external-host!" });
        }
        break;
      }
      const apiPath = arg.match(/^\/?repos\/([^/]+)\/([^/?#]+)(?:\/|$)/iu);
      if (apiPath) {
        hints.push({ source: "API path", repository: canonicalSlug(`${apiPath[1]}/${apiPath[2]}`) });
        break;
      }
      if (!arg.startsWith("-")) break;
      if (["--hostname", "--method", "-H", "-F", "-f", "-X", "-H", "--header", "--field", "--raw-field", "--input"].includes(arg)) index++;
    }
  }

  const repoCommand = args.indexOf("repo");
  if (repoCommand >= 0 && ["view", "clone"].includes(args[repoCommand + 1])) {
    const subcommand = args[repoCommand + 1];
    for (let index = repoCommand + 2; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--") {
        if (args[index + 1]) hints.push({ source: `repo ${subcommand}`, repository: repositoryFromTarget(args[index + 1]) });
        break;
      }
      if (["--json", "--jq", "--template", "--branch", "-b"].includes(arg)) { index++; continue; }
      if (arg === "--repo" || arg === "-R") { index++; continue; }
      if (arg.startsWith("--") && arg.includes("=")) continue;
      if (arg.startsWith("-")) break;
      hints.push({ source: `repo ${subcommand}`, repository: repositoryFromTarget(arg) });
      break;
    }
  }

  return { hints, unboundRepoFlag };
}

function ghTarget(args, env, cwd) {
  const { hints, unboundRepoFlag } = extractHints(args, env);
  const externalHost = hints.some(hint => hint.repository === "!external-host!");
  const resolved = sameRepository(hints.filter(hint => hint.repository !== "!external-host!"));
  if (resolved) {
    if (unboundRepoFlag) fail("A repository flag is missing its target.");
    return { repository: resolved, externalHost };
  }
  if (unboundRepoFlag) return { repository: null, unresolvedRepoFlag: true, externalHost };
  try {
    const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (remote.status !== 0 || !remote.stdout.trim()) return { repository: null, externalHost };
    return { repository: repositoryFromRemote(remote.stdout.trim()), externalHost };
  } catch (error) {
    if (error instanceof ClientError) throw error;
    return { repository: null, externalHost };
  }
}

function rejectNonGitHubHost(args, env) {
  if (env.GH_HOST && env.GH_HOST.toLowerCase() !== "github.com") fail("GH_HOST must be github.com for configured repositories.");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--hostname") {
      const host = args[index + 1];
      if (!host) fail("--hostname needs a value.");
      if (host.toLowerCase() !== "github.com") fail("Only github.com is allowed for configured repositories.");
      index++;
    } else if (arg.startsWith("--hostname=")) {
      if (arg.slice("--hostname=".length).toLowerCase() !== "github.com") fail("Only github.com is allowed for configured repositories.");
    }
  }
}

function runChild(file, args, { env, cwd, inherit = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    child.once("error", () => reject(new ClientError("Configured GitHub CLI could not be started.")));
    child.once("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
  });
}

async function gh(config, args) {
  if (args[0] !== "--" || args.length < 2) fail("Usage: gh -- <gh-args>.");
  const ghArgs = args.slice(1);
  const env = process.env;
  const target = ghTarget(ghArgs, env, process.cwd());
  const repository = target.repository;
  if (target.externalHost && repository && configured(config, repository)) fail("A configured GitHub token cannot be used with a non-GitHub API URL.");
  const bound = repository ? configured(config, repository) : undefined;
  if (!bound) {
    const result = await runChild(config.githubCli, ghArgs, { env, cwd: process.cwd() });
    process.exitCode = result.code;
    return;
  }
  rejectNonGitHubHost(ghArgs, env);
  const tokenState = cacheStatus(config, bound);
  if (tokenState.state !== "ready") failClosedCache(config, bound);
  const childEnv = { ...env, GH_TOKEN: tokenState.token, GH_HOST: "github.com" };
  delete childEnv.GITHUB_TOKEN;
  delete childEnv.GH_ENTERPRISE_TOKEN;
  delete childEnv.GITHUB_ENTERPRISE_TOKEN;
  const result = await runChild(config.githubCli, ghArgs, { env: childEnv, cwd: process.cwd() });
  process.exitCode = result.code;
}

function parseCredential(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return values;
}

function credentialRepository(values) {
  if (values.get("protocol") !== "https") return null;
  const host = values.get("host") ?? "";
  const hostMatch = host.match(/^github\.com(?::(\d+))?$/iu);
  if (!hostMatch) return null;
  if (hostMatch[1] && hostMatch[1] !== "443") fail("Git credential host is ambiguous.");
  let path = values.get("path") ?? "";
  if (path.endsWith("/")) path = path.slice(0, -1);
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("%") || path.includes("?") || path.includes("#")) fail("Git credential repository path is ambiguous.");
  const parts = path.split("/");
  if (parts.length !== 2) fail("Git credential repository path is ambiguous.");
  return canonicalSlug(path);
}

async function credential(config, args) {
  const operation = args[0];
  if (!new Set(["get", "store", "erase"]).has(operation) || args.length !== 1) fail("Usage: credential <get|store|erase>.");
  const input = readFileSync(0, "utf8");
  if (Buffer.byteLength(input, "utf8") > 32768) fail("Git credential request is too large.");
  const values = parseCredential(input);
  const repository = credentialRepository(values);
  const bound = repository ? configured(config, repository) : undefined;
  if (operation !== "get" || !bound) return;
  const state = cacheStatus(config, bound);
  if (state.state !== "ready") failClosedCache(config, bound);
  process.stdout.write(`username=x-access-token\npassword=${state.token}\n\n`);
}

function status(config, args) {
  if (args.length > 1) fail("Usage: status [OWNER/REPO].");
  const repositories = args.length ? [canonicalSlug(args[0])] : config.repositories;
  const result = repositories.map(repository => {
    if (!configured(config, repository)) return { repository, configured: false, cache: "not-applicable" };
    const cache = cacheStatus(config, repository);
    return { repository, configured: true, cache: cache.state, ...(cache.expiresAt ? { expiresAt: cache.expiresAt } : {}) };
  });
  process.stdout.write(`${JSON.stringify(args.length === 1 ? result[0] : { repositories: result }, null, 2)}\n`);
}

async function main(argv) {
  const hasConfig = argv[0] === "--config" && Boolean(argv[1]);
  const commandIndex = hasConfig ? 2 : 0;
  const command = argv[commandIndex];
  const args = argv.slice(commandIndex + 1);
  const credentialGet = command === "credential" && args[0] === "get";
  if (!hasConfig) {
    if (credentialGet) process.stdout.write("quit=true\n\n");
    fail("Usage: --config FILE <gh|credential|status>.");
  }
  let config;
  try { config = loadConfig(argv[1]); }
  catch (error) {
    if (credentialGet) process.stdout.write("quit=true\n\n");
    throw error;
  }
  if (command === "gh") return gh(config, args);
  if (command === "credential") {
    try { return await credential(config, args); }
    catch (error) {
      if (credentialGet) process.stdout.write("quit=true\n\n");
      throw error;
    }
  }
  if (command === "status") return status(config, args);
  fail("Command must be gh, credential, or status.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    if (error instanceof ClientError) process.stderr.write(`${error.message}\n`);
    else process.stderr.write("GitHub App client failed.\n");
    process.exitCode = 1;
  });
}
