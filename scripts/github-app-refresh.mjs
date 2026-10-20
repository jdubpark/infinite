#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { createHash, createPrivateKey, sign, randomBytes } from "node:crypto";
import { dirname, isAbsolute, resolve, basename, join } from "node:path";

const API = "https://api.github.com";
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DISCOVERY_PAGE_BYTES = 1024 * 1024;
const MAX_INSTALLATION_TOKEN_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const TOKEN_VALID_FOR_MS = 15 * 60 * 1000;
const EXPECTED_PERMISSIONS = Object.freeze({
  contents: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
  metadata: "read",
});
const TOKEN_FILE_SCHEMA = 1;

class RefreshError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new RefreshError(code);
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code);
}

function canonicalPath(value, code) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) fail(code);
  return value;
}

async function secureFile(path, label, maxBytes) {
  await assertNoSymlinkParent(path, label);
  let before;
  try {
    before = await lstat(path);
  } catch {
    fail(`${label}-unavailable`);
  }
  if (!before.isFile() || before.isSymbolicLink()) fail(`${label}-not-regular-file`);
  const trustedOwners = new Set([0, typeof process.getuid === "function" ? process.getuid() : 0]);
  if (!trustedOwners.has(before.uid)) fail(`${label}-owner`);
  if ((before.mode & 0o077) !== 0) fail(`${label}-permissions`);
  if (before.size > maxBytes) fail(`${label}-too-large`);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || !trustedOwners.has(after.uid) || (after.mode & 0o077) !== 0 || after.size > maxBytes) fail(`${label}-changed`);
    return await handle.readFile();
  } catch (error) {
    if (error instanceof RefreshError) throw error;
    fail(`${label}-unavailable`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertNoSymlinkParent(path, label) {
  let current = "/";
  const trustedOwners = new Set([0, typeof process.getuid === "function" ? process.getuid() : 0]);
  const components = path.slice(1).split("/").filter(Boolean).slice(0, -1);
  for (const component of components) {
    current = join(current, component);
    let info;
    try { info = await lstat(current); } catch { fail(`${label}-parent-unavailable`); }
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label}-parent-invalid`);
    if (!trustedOwners.has(info.uid)) fail(`${label}-parent-owner`);
    if ((info.mode & 0o022) !== 0) fail(`${label}-parent-permissions`);
  }
}

function validateRepositoryName(value) {
  if (typeof value !== "string" || value !== value.toLowerCase()) fail("repository-name");
  const match = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/(\.github|[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)$/.exec(value);
  if (!match || match[1].length > 39 || match[2].length > 100 || match[2].endsWith(".git")) fail("repository-name");
  return value;
}

function positiveId(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("config-shape");
  const allowed = ["appId", "privateKeyFile", "tokenDirectory", "tokenGroupId", "repositories", "installations"];
  if (Object.keys(input).some((key) => !allowed.includes(key)) || ["appId", "privateKeyFile", "tokenDirectory", "tokenGroupId"].some((key) => !Object.hasOwn(input, key))) fail("config-shape");
  if (typeof input.appId !== "string" || !/^[0-9]{1,20}$/.test(input.appId)) fail("app-id");
  canonicalPath(input.privateKeyFile, "private-key-path");
  canonicalPath(input.tokenDirectory, "token-directory-path");
  if (!Number.isSafeInteger(input.tokenGroupId) || input.tokenGroupId < 0) fail("token-group-id");
  if (!Array.isArray(input.repositories) && !Array.isArray(input.installations)) fail("config-shape");
  if (input.repositories !== undefined && (!Array.isArray(input.repositories) || input.repositories.length > 500)) fail("repositories");
  if (input.installations !== undefined && (!Array.isArray(input.installations) || input.installations.length < 1 || input.installations.length > 100)) fail("installations");
  if ((!input.repositories || input.repositories.length === 0) && (!input.installations || input.installations.length === 0)) fail(input.installations ? "installations" : "repositories");
  const names = new Set();
  const ids = new Set();
  const repositories = (input.repositories ?? []).map((item) => {
    exactKeys(item, ["repository", "repositoryId", "installationId"], "repository-shape");
    const repository = validateRepositoryName(item.repository);
    const repositoryId = positiveId(item.repositoryId, "repository-id");
    const installationId = positiveId(item.installationId, "installation-id");
    if (names.has(repository) || ids.has(repositoryId)) fail("duplicate-repository");
    names.add(repository);
    ids.add(repositoryId);
    return { repository, repositoryId, installationId };
  });
  const installationIds = new Set();
  const installations = (input.installations ?? []).map((item) => {
    exactKeys(item, ["installationId"], "installations");
    const installationId = positiveId(item.installationId, "installations");
    if (installationIds.has(installationId)) fail("installations");
    installationIds.add(installationId);
    return { installationId };
  });
  return { ...input, repositories, installations };
}

function base64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

function createAppJwt(appId, privateKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64url({ alg: "RS256", typ: "JWT" });
  const payload = base64url({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId });
  const signingInput = `${header}.${payload}`;
  let signature;
  try {
    signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  } catch {
    fail("private-key-invalid");
  }
  return `${signingInput}.${signature}`;
}

async function ensureTokenDirectory(path, groupId) {
  await assertNoSymlinkParent(path, "token-directory");
  const parent = dirname(path);
  let parentInfo;
  try { parentInfo = await lstat(parent); } catch { fail("token-directory-parent-unavailable"); }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail("token-directory-parent-invalid");
  const owner = typeof process.getuid === "function" ? process.getuid() : 0;
  if (![0, owner].includes(parentInfo.uid) || (parentInfo.mode & 0o022) !== 0) fail("token-directory-parent-permissions");
  try { await mkdir(path, { mode: 0o750 }); } catch (error) { if (error?.code !== "EEXIST") fail("token-directory-create"); }
  let info;
  try { info = await lstat(path); } catch { fail("token-directory-unavailable"); }
  if (!info.isDirectory() || info.isSymbolicLink()) fail("token-directory-invalid");
  if (info.uid !== owner || (info.mode & 0o022) !== 0) fail("token-directory-permissions");
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino) fail("token-directory-changed");
    await handle.chown(owner, groupId);
    await handle.chmod(0o750);
  } catch (error) {
    if (error instanceof RefreshError) throw error;
    fail("token-directory-ownership");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function privateStagingDirectory(directory) {
  const path = join(directory, ".staging");
  const owner = typeof process.getuid === "function" ? process.getuid() : 0;
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") fail("cache-staging-create"); }
  let info;
  try { info = await lstat(path); } catch { fail("cache-staging-unavailable"); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner || (info.mode & 0o077) !== 0) fail("cache-staging-permissions");
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== info.dev || opened.ino !== info.ino || opened.uid !== owner) fail("cache-staging-changed");
    await handle.chmod(0o700);
  } catch (error) {
    if (error instanceof RefreshError) throw error;
    fail("cache-staging-permissions");
  } finally {
    await handle?.close().catch(() => {});
  }
  return path;
}

function tokenPath(directory, repository) {
  const digest = createHash("sha256").update(repository.toLowerCase()).digest("hex");
  return join(directory, `${digest}.json`);
}

function exactPermissions(permissions) {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return false;
  const keys = Object.keys(permissions).sort();
  const expectedKeys = Object.keys(EXPECTED_PERMISSIONS).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]) && expectedKeys.every((key) => permissions[key] === EXPECTED_PERMISSIONS[key]);
}

function validToken(value) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_TOKEN_BYTES && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

async function cachedToken(path, repository, groupId, nowMs = Date.now()) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return undefined; fail("cache-unavailable"); }
  if (info.isSymbolicLink() || !info.isFile()) fail("cache-not-regular-file");
  const owner = typeof process.getuid === "function" ? process.getuid() : 0;
  if (info.uid !== owner || info.gid !== groupId || (info.mode & 0o777) !== 0o640 || info.size > 32 * 1024) fail("cache-permissions");
  let raw;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.uid !== owner || opened.gid !== groupId || (opened.mode & 0o777) !== 0o640 || opened.size > 32 * 1024) return undefined;
    raw = await handle.readFile();
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
  let data;
  try { data = JSON.parse(raw.toString("utf8")); } catch { return undefined; }
  try { exactKeys(data, ["schemaVersion", "repository", "repositoryId", "installationId", "token", "expiresAt", "permissions"], "cache-shape"); } catch { return undefined; }
  if (!data || data.schemaVersion !== TOKEN_FILE_SCHEMA || data.repository !== repository.repository || data.repositoryId !== repository.repositoryId || data.installationId !== repository.installationId || !validToken(data.token) || !exactPermissions(data.permissions)) return undefined;
  const expires = Date.parse(data.expiresAt);
  if (!Number.isFinite(expires) || expires <= nowMs + TOKEN_VALID_FOR_MS || expires > nowMs + 75 * 60_000) return undefined;
  return data;
}

async function boundedBody(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        fail("response-too-large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function requestInstallationToken(repository, jwt) {
  const endpoint = `${API}/app/installations/${repository.installationId}/access_tokens`;
  const payload = {
    repository_ids: [repository.repositoryId],
    permissions: EXPECTED_PERMISSIONS,
  };
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    fail("provider-request-failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    fail(`provider-http-${response.status}`);
  }
  let body;
  try { body = JSON.parse(await boundedBody(response)); } catch (error) {
    if (error instanceof RefreshError) throw error;
    fail("provider-response-json");
  }
  if (!body || !validToken(body.token)) fail("provider-token-invalid");
  if (!Array.isArray(body.repositories) || body.repositories.length !== 1) fail("provider-scope-invalid");
  const scope = body.repositories[0];
  if (!scope || scope.id !== repository.repositoryId || typeof scope.full_name !== "string" || scope.full_name.toLowerCase() !== repository.repository) fail("provider-scope-invalid");
  if (!exactPermissions(body.permissions)) fail("provider-permissions-invalid");
  if (typeof body.expires_at !== "string") fail("provider-expiry-invalid");
  const expiresMs = Date.parse(body.expires_at);
  const nowMs = Date.now();
  if (!Number.isFinite(expiresMs) || expiresMs < nowMs + 60_000 || expiresMs > nowMs + 75 * 60_000) fail("provider-expiry-invalid");
  return {
    schemaVersion: TOKEN_FILE_SCHEMA,
    repository: repository.repository,
    repositoryId: repository.repositoryId,
    installationId: repository.installationId,
    token: body.token,
    expiresAt: new Date(expiresMs).toISOString(),
    permissions: EXPECTED_PERMISSIONS,
  };
}

async function requestUnrestrictedInstallationToken(installationId, jwt) {
  let response;
  try {
    response = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ permissions: EXPECTED_PERMISSIONS }),
    });
  } catch { fail("discovery-failed"); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    fail("discovery-failed");
  }
  let body;
  try { body = JSON.parse(await boundedBody(response, MAX_INSTALLATION_TOKEN_RESPONSE_BYTES)); } catch { fail("discovery-failed"); }
  if (!body || !validToken(body.token)) fail("discovery-failed");
  return body.token;
}

async function discoverInstallationRepositories(installation, jwt, limit) {
  const token = await requestUnrestrictedInstallationToken(installation.installationId, jwt);
  const repositories = [];
  let totalCount;
  for (let page = 1; page <= Math.max(1, Math.ceil(limit / 100)); page += 1) {
    let response;
    try {
      response = await fetch(`${API}/installation/repositories?per_page=100&page=${page}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch { fail("discovery-failed"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail("discovery-failed");
    }
    let body;
    try { body = JSON.parse(await boundedBody(response, MAX_DISCOVERY_PAGE_BYTES)); } catch {
      fail("discovery-failed");
    }
    if (!body || !Array.isArray(body.repositories) || body.repositories.length > 100) fail("discovery-failed");
    if (!Number.isSafeInteger(body.total_count) || body.total_count < 0 || body.total_count > limit) fail("discovery-failed");
    if (totalCount !== undefined && body.total_count !== totalCount) fail("discovery-failed");
    totalCount = body.total_count;
    const expectedPageSize = Math.min(100, totalCount - repositories.length);
    if (expectedPageSize < 0 || body.repositories.length !== expectedPageSize) fail("discovery-failed");
    for (const repository of body.repositories) {
      if (!repository || !Number.isSafeInteger(repository.id) || repository.id <= 0) fail("discovery-failed");
      let name;
      try { name = validateRepositoryName(typeof repository.full_name === "string" ? repository.full_name.toLowerCase() : ""); } catch { fail("discovery-failed"); }
      repositories.push({ repository: name, repositoryId: repository.id, installationId: installation.installationId });
      if (repositories.length > limit) fail("discovery-failed");
    }
    if (repositories.length === totalCount) break;
  }
  if (repositories.length !== totalCount) fail("discovery-failed");
  return repositories;
}

async function discoverRepositories(config, jwt) {
  const explicit = new Map(config.repositories.map((repository) => [repository.repository, repository]));
  const discovered = new Map();
  const ids = new Set(config.repositories.map((repository) => repository.repositoryId));
  let totalDiscovered = 0;
  for (const installation of config.installations) {
    const remaining = Math.max(0, 500 - totalDiscovered);
    const repositories = await discoverInstallationRepositories(installation, jwt, remaining);
    totalDiscovered += repositories.length;
    for (const repository of repositories) {
      if (explicit.has(repository.repository)) continue;
      const previous = discovered.get(repository.repository);
      if ((previous && (previous.repositoryId !== repository.repositoryId || previous.installationId !== repository.installationId)) || (ids.has(repository.repositoryId) && !previous)) fail("discovery-failed");
      discovered.set(repository.repository, repository);
      ids.add(repository.repositoryId);
    }
  }
  const repositories = [...explicit.values(), ...discovered.values()];
  if (repositories.length > 500) fail("discovery-failed");
  return repositories;
}

async function removeStaleTokens(directory, repositories) {
  const current = new Set(repositories.map((repository) => basename(tokenPath(directory, repository.repository))));
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { fail("cache-unavailable"); }
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name) || current.has(entry.name)) continue;
    const path = join(directory, entry.name);
    let info;
    try { info = await lstat(path); } catch (error) {
      if (error?.code === "ENOENT") continue;
      fail("cache-cleanup-failed");
    }
    if (info.isFile() && !info.isSymbolicLink()) {
      try { await unlink(path); } catch (error) {
        if (error?.code !== "ENOENT") fail("cache-cleanup-failed");
      }
    }
  }
}

async function writeTokenAtomically(directory, filePath, value, groupId) {
  const owner = typeof process.getuid === "function" ? process.getuid() : 0;
  try {
    const existing = await lstat(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) fail("cache-not-regular-file");
  } catch (error) {
    if (error instanceof RefreshError) throw error;
    if (error?.code !== "ENOENT") fail("cache-unavailable");
  }
  const staging = await privateStagingDirectory(directory);
  const temporary = join(staging, `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow, 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.chown(owner, groupId);
    await handle.chmod(0o640);
    await handle.sync();
    await rename(temporary, filePath);
    await handle.close();
    handle = undefined;
    for (const path of [directory, staging]) {
      const directoryHandle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } catch {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    fail("cache-write-failed");
  }
}

async function refreshOne(repository, jwt, config) {
  const path = tokenPath(config.tokenDirectory, repository.repository);
  const token = await requestInstallationToken(repository, jwt);
  await writeTokenAtomically(config.tokenDirectory, path, token, config.tokenGroupId);
  return "refreshed";
}

async function run(configPath) {
  if (typeof configPath !== "string" || configPath.length === 0) fail("config-path");
  const configRaw = await secureFile(resolve(configPath), "config", MAX_CONFIG_BYTES);
  let parsed;
  try { parsed = JSON.parse(configRaw.toString("utf8")); } catch { fail("config-json"); }
  const config = validateConfig(parsed);
  await secureFile(config.privateKeyFile, "private-key", 1024 * 1024);
  await ensureTokenDirectory(config.tokenDirectory, config.tokenGroupId);
  const configuredTokens = await Promise.all(config.repositories.map(async (repository) => {
    try { return await cachedToken(tokenPath(config.tokenDirectory, repository.repository), repository, config.tokenGroupId); }
    catch { return undefined; }
  }));
  const needsJwt = config.installations.length > 0 || configuredTokens.some((token) => !token);
  let jwt;
  if (needsJwt) {
    let key;
    try { key = createPrivateKey((await secureFile(config.privateKeyFile, "private-key", 1024 * 1024)).toString("utf8")); } catch (error) {
      if (error instanceof RefreshError) throw error;
      fail("private-key-invalid");
    }
    jwt = createAppJwt(config.appId, key);
  }
  let repositories = config.repositories;
  if (config.installations.length > 0) repositories = await discoverRepositories(config, jwt);
  const currentTokens = await Promise.all(repositories.map(async (repository) => {
    try { return { value: await cachedToken(tokenPath(config.tokenDirectory, repository.repository), repository, config.tokenGroupId) }; }
    catch (error) { return { error: error instanceof RefreshError ? error.code : "cache-unavailable" }; }
  }));
  const needsRefresh = currentTokens.some((cached) => !cached.error && !cached.value);
  if (needsRefresh && !jwt) {
    let key;
    try { key = createPrivateKey((await secureFile(config.privateKeyFile, "private-key", 1024 * 1024)).toString("utf8")); } catch (error) {
      if (error instanceof RefreshError) throw error;
      fail("private-key-invalid");
    }
    jwt = createAppJwt(config.appId, key);
  }
  const results = new Array(repositories.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(16, repositories.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= repositories.length) return;
      const repository = repositories[index];
      const name = repository.repository;
      if (currentTokens[index].error) {
        console.error(`${name}: failed (${currentTokens[index].error})`);
        results[index] = false;
        continue;
      }
      if (currentTokens[index].value) {
        console.log(`${name}: cached`);
        results[index] = true;
        continue;
      }
      try {
        await refreshOne(repository, jwt, config);
        console.log(`${name}: refreshed`);
        results[index] = true;
      } catch (error) {
        const code = error instanceof RefreshError ? error.code : "refresh-failed";
        console.error(`${name}: failed (${code})`);
        results[index] = false;
      }
    }
  });
  await Promise.all(workers);
  if (config.installations.length > 0) await removeStaleTokens(config.tokenDirectory, repositories);
  if (results.some((result) => !result)) process.exitCode = 1;
}

function usage() {
  console.log("Usage: github-app-refresh.mjs --config FILE");
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") return usage();
  if (argv.length !== 2 || argv[0] !== "--config") fail("usage");
  await run(argv[1]);
}

main(process.argv.slice(2)).catch((error) => {
  const code = error instanceof RefreshError ? error.code : "refresh-failed";
  console.error(`github-app-refresh: failed (${code})`);
  process.exitCode = 1;
});
