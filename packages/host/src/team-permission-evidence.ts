import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, closeSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Prompt } from "@infinite/attention";
import { dialogCommand } from "@infinite/attention";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 36 * 1024;
const EXCLUDED = /^(?:\.git|node_modules|.*\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|private|\.local|id_rsa|id_ed25519|[^/]+\.(?:pem|key))$/i;
const RELEVANT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".sh", ".bash", ".py", ".json", ".yaml", ".yml", ".toml", ".mk"]);
const SCRIPT_RUNNERS = new Set(["node", "tsx", "ts-node", "bun", "deno", "python", "python3", "sh", "bash"]);
const SAFE_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);

export interface PermissionEvidenceFile {
  /** Repository-relative path, or an @scratch/<index>/... path for a host-approved scratch file. */
  path: string;
  sha256: string;
  /** Complete UTF-8 file content. Oversized files are omitted and named in limitations. */
  content: string;
}

export interface PermissionEvidenceSnapshot {
  files: PermissionEvidenceFile[];
  limitations: string[];
  digest: string;
}

export interface CollectPermissionEvidenceInput {
  prompt: Prompt;
  cwd: string;
  changedPaths: string[];
  baseCommit?: string;
  /** Exact scratch directories approved by the host for this permission decision. */
  approvedScratchRoots?: string[];
}

/**
 * Collect bounded, read-only source evidence for a permission review. This does not evaluate
 * whether a command is safe or authorize it. Unsupported or incomplete command forms are called
 * out explicitly so the coordinator can escalate rather than infer missing source.
 */
export function collectPermissionEvidence(input: CollectPermissionEvidenceInput): PermissionEvidenceSnapshot {
  const limitations: string[] = [];
  const files = new Map<string, PermissionEvidenceFile>();
  let root: string;
  try { root = findRepositoryRoot(input.cwd); }
  catch { return snapshot(files, ["Could not identify a real repository root for the target workspace."]); }
  const cwd = realpathSync(input.cwd);
  const scratchRoots = approvedScratchRoots(input.approvedScratchRoots ?? [], cwd, limitations);

  const command = completeCommand(input.prompt, limitations);
  const commands = command ? splitLiteralCommandChain(command, limitations) : undefined;
  if (commands) for (const part of commands) {
    const argv = tokenize(part, limitations);
    if (argv?.length) collectCommandEvidence(argv, root, cwd, scratchRoots, input.changedPaths, files, limitations);
  }
  // Include changed command/config sources even when the command itself is direct. This is
  // evidence only; scope and whether the request may use a changed file remain owner decisions.
  for (const path of input.changedPaths) {
    if (looksLikeChangedCommandDefinition(path)) addFile(path, root, cwd, scratchRoots, files, limitations);
  }
  return snapshot(files, limitations);
}

/** Stable digest for comparing a freshly collected answer-time snapshot with the reviewed one. */
export function permissionEvidenceDigest(snapshotValue: Pick<PermissionEvidenceSnapshot, "files" | "limitations">): string {
  const canonical = {
    files: [...snapshotValue.files].sort((a, b) => a.path.localeCompare(b.path)).map(({ path, sha256, content }) => ({ path, sha256, content })),
    limitations: [...snapshotValue.limitations].sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function snapshot(files: Map<string, PermissionEvidenceFile>, limitations: string[]): PermissionEvidenceSnapshot {
  const normalized = [...new Set(limitations)].sort();
  const values = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { files: values, limitations: normalized, digest: permissionEvidenceDigest({ files: values, limitations: normalized }) };
}

function completeCommand(prompt: Prompt, limitations: string[]): string | undefined {
  if (prompt.source === "screen" && prompt.pinned && !prompt.tool) {
    const command = dialogCommand(prompt);
    if (command) return command;
    limitations.push("The visible command dialog is incomplete or ambiguous; no command source was inferred.");
    return undefined;
  }
  const input = prompt.tool?.input;
  if (!prompt.tool || prompt.tool.inputComplete !== true || !input) {
    limitations.push("The provider command input is not recorded as complete.");
    return undefined;
  }
  if (!["Bash", "PowerShell"].includes(prompt.tool.name)) {
    limitations.push("The complete provider input is not from a supported shell command tool.");
    return undefined;
  }
  if (typeof input.command !== "string" || !input.command.trim()) {
    limitations.push("The complete provider input does not contain one supported literal command string.");
    return undefined;
  }
  return input.command;
}

function splitLiteralCommandChain(command: string, limitations: string[]): string[] | undefined {
  if (/[\n\r\0]/.test(command) || /[|;<>`]/.test(command) || /\$\(|\$\{|\$[A-Za-z_]/.test(command)) {
    limitations.push("The command uses shell composition, expansion, or multiple lines; source collection is incomplete.");
    return undefined;
  }
  const parts: string[] = [];
  let start = 0, quote: "'" | '"' | undefined, escaped = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "&") {
      if (command[index + 1] !== "&") { limitations.push("A standalone shell background operator is unsupported."); return undefined; }
      const part = command.slice(start, index).trim();
      if (!part) { limitations.push("The shell command chain contains an empty command."); return undefined; }
      parts.push(part);
      start = ++index + 1;
    }
  }
  if (quote || escaped) { limitations.push("The command contains an unterminated quote or escape."); return undefined; }
  const final = command.slice(start).trim();
  if (!final) { limitations.push("The shell command chain ends without a command."); return undefined; }
  parts.push(final);
  return parts;
}

/** A deliberately small shell-word parser; any shell composition or expansion is a limitation. */
function tokenize(command: string, limitations: string[]): string[] | undefined {
  if (/[\n\r\0]/.test(command) || /[|;&<>`]/.test(command) || /\$\(|\$\{|\$[A-Za-z_]/.test(command)) {
    limitations.push("The command segment uses unsupported shell syntax.");
    return undefined;
  }
  const words: string[] = [];
  let word = "", quote: "'" | '"' | undefined, escaped = false, started = false;
  for (const char of command.trim()) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = undefined; else word += char; started = true; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) { words.push(word); word = ""; started = false; } continue; }
    word += char; started = true;
  }
  if (escaped || quote) { limitations.push("The command contains an unterminated quote or escape."); return undefined; }
  if (started) words.push(word);
  if (!words.length || words.some(word => /[*?\[\]]/.test(word))) {
    limitations.push("The command is not a single literal executable invocation.");
    return undefined;
  }
  return words;
}

function collectCommandEvidence(argv: string[], root: string, cwd: string, scratchRoots: string[], changedPaths: string[], files: Map<string, PermissionEvidenceFile>, limitations: string[]) {
  const executable = basename(argv[0]).replace(/\.cmd$/i, "").toLowerCase();
  if (SAFE_PACKAGE_MANAGERS.has(executable)) {
    collectPackageCommand(executable, argv.slice(1), root, cwd, scratchRoots, files, limitations);
    return;
  }
  if (SCRIPT_RUNNERS.has(executable)) {
    const script = argv.find((arg, index) => index > 0 && !arg.startsWith("-") && looksLikeCommandSource(arg));
    if (script) addFile(script, root, cwd, scratchRoots, files, limitations);
    else if (argv.some(arg => arg === "-e" || arg === "-c")) limitations.push("The command executes inline code rather than a collected local script file.");
    else limitations.push("No explicit local script file was found in the command.");
    collectFlaggedConfigs(argv, root, cwd, scratchRoots, files, limitations);
    return;
  }
  if (["playwright", "vitest", "jest", "vite", "webpack", "rollup"].includes(executable)) {
    for (const name of defaultConfigNames(executable)) if (existsRegular(join(root, name))) addFile(name, root, cwd, scratchRoots, files, limitations);
    const testPath = argv.find(arg => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(arg));
    if (testPath) addFile(testPath, root, cwd, scratchRoots, files, limitations);
    else if (["playwright", "vitest", "jest"].includes(executable)) limitations.push("The test runner did not name an explicit test file; default test discovery is not part of this source snapshot.");
    collectFlaggedConfigs(argv, root, cwd, scratchRoots, files, limitations);
    return;
  }
  if (executable === "git") {
    return;
  }
  limitations.push(`No supported static source mapping is defined for executable ${executable || "(empty)"}.`);
  for (const path of changedPaths) if (looksLikeCommandSource(path)) addFile(path, root, cwd, scratchRoots, files, limitations);
}

function collectPackageCommand(manager: string, args: string[], root: string, cwd: string, scratchRoots: string[], files: Map<string, PermissionEvidenceFile>, limitations: string[]) {
  const rootManifest = addFile("package.json", root, cwd, scratchRoots, files, limitations);
  const boundary = args.indexOf("--");
  const options = boundary < 0 ? args : args.slice(0, boundary);
  if (options.some(arg => /^(?:--(?:filter|prefix|dir|cwd|workspaces|global|recursive)(?:=|$)|-[CrgW])/.test(arg) || arg === "workspace") ||
      manager !== "npm" && options.some(arg => /^--workspace(?:=|$)|^-w/.test(arg))) {
    limitations.push(`The ${manager} directory or workspace selection is not mapped to one local manifest.`);
    return;
  }
  // Normalize the supported npm selectors before resolving command sources. Script arguments
  // after -- cannot change npm's working directory and are intentionally excluded here.
  const selectors: string[] = [];
  for (let index = 0; index < options.length; index++) {
    const arg = options[index];
    if (arg === "-w" || arg === "--workspace") selectors.push(options[++index] ?? "");
    else if (arg.startsWith("--workspace=")) selectors.push(arg.slice("--workspace=".length));
    else if (arg.startsWith("-w")) selectors.push(arg.slice(2));
    else if (/^--(?:work|pref)/.test(arg)) {
      limitations.push("An abbreviated package directory or workspace selector is unsupported.");
      return;
    }
  }
  let packageRoot = root;
  const workspace = selectors[0];
  if (selectors.length > 1 || selectors.length && (!workspace || workspace.startsWith("-") || workspace.includes(".."))) {
    limitations.push("The workspace selector is missing, dynamic, or unsafe to resolve statically.");
    return;
  } else if (workspace) {
    const candidates = [resolve(root, workspace), resolve(root, "packages", workspace)];
    const resolved = candidates.find(candidate => within(root, candidate) && existsRegular(join(candidate, "package.json")));
    if (resolved) {
      packageRoot = resolved;
      addFile(relative(root, join(resolved, "package.json")), root, cwd, scratchRoots, files, limitations);
    } else {
      limitations.push("The selected package workspace could not be resolved to a regular local package manifest.");
      return;
    }
  }
  const commandIndex = args.findIndex(arg => ["run", "test", "build", "lint", "exec", "x", "dlx", "install", "add", "publish", "deploy"].includes(arg));
  if (commandIndex < 0) {
    limitations.push(`The ${manager} command does not name a statically inspectable script entrypoint.`);
    return;
  }
  const verb = args[commandIndex];
  const name = verb === "run" ? args[commandIndex + 1] : ["test", "build", "lint"].includes(verb) ? verb : undefined;
  if (name && rootManifest) {
    const manifestFile = packageRoot === root ? rootManifest : addFile(join(packageRoot, "package.json"), root, cwd, scratchRoots, files, limitations);
    const manifestPath = manifestFile?.path ?? relative(root, join(packageRoot, "package.json"));
    let manifest: Record<string, unknown> | undefined;
    try { manifest = manifestFile ? JSON.parse(manifestFile.content) as Record<string, unknown> : undefined; } catch { limitations.push(`Could not parse ${manifestPath} as JSON.`); }
    const scripts = manifest?.scripts;
    if (scripts && typeof scripts === "object" && typeof (scripts as Record<string, unknown>)[name] === "string") {
      const script = (scripts as Record<string, string>)[name];
      if (/\bcd\s+/.test(script)) limitations.push(`Package script ${name} changes directory; relative source resolution may be incomplete.`);
      collectReferencedSources(script, root, packageRoot, scratchRoots, files, limitations, 0, packageRoot);
    } else limitations.push(`Package script ${name} was not found in ${manifestPath}.`);
  }
  collectFlaggedConfigs(args, root, packageRoot, scratchRoots, files, limitations);
  if (["exec", "x", "dlx", "install", "add", "publish", "deploy"].includes(verb)) limitations.push(`The ${manager} ${verb} command has behavior beyond a local script run; source evidence cannot bound its effects.`);
}

function collectReferencedSources(command: string, root: string, cwd: string, scratchRoots: string[], files: Map<string, PermissionEvidenceFile>, limitations: string[], depth: number, packageRoot = root) {
  if (depth > 3) { limitations.push("Nested package script references exceed the static inspection depth limit."); return; }
  if (/\$\(|\$\{|\$[A-Za-z_]|\b(?:eval|xargs|curl|wget|npx|npm\s+exec|pnpm\s+dlx|yarn\s+dlx)\b/i.test(command)) {
    limitations.push("A package script uses dynamic execution, a downloader, or a package runner; referenced source is incomplete.");
  }
  const matches = [...command.matchAll(/(?:^|[\s;&|])(?:node|tsx|ts-node|bun|deno|python3?|sh|bash)\s+(?:--[\w-]+\s+|-[A-Za-z]+\s+)*(['"]?)([^\s'";&|]+\.(?:[cm]?[jt]sx?|py|sh|bash))\1/g)];
  for (const match of matches) addFile(match[2], root, cwd, scratchRoots, files, limitations);
  const configMatches = [...command.matchAll(/(?:--config(?:=|\s+)|--project(?:=|\s+))(['"]?)([^\s'";&|]+)\1/g)];
  for (const match of configMatches) addFile(match[2], root, cwd, scratchRoots, files, limitations);
  const toolName = /\b(playwright|vitest|jest|vite|webpack|rollup)\b/i.exec(command)?.[1]?.toLowerCase();
  if (toolName) {
    for (const name of defaultConfigNames(toolName)) if (existsRegular(join(packageRoot, name))) addFile(join(packageRoot, name), root, cwd, scratchRoots, files, limitations);
    const testPathPattern = new RegExp(`\\b${toolName}(?:\\s+test)?\\s+([^\\s;&|]+\\.(?:spec|test)\\.[cm]?[jt]sx?)`, "i");
    const testPath = testPathPattern.exec(command)?.[1];
    if (testPath) addFile(testPath, root, cwd, scratchRoots, files, limitations);
  }
  const nested = [...command.matchAll(/(?:npm|pnpm|yarn)\s+run\s+([A-Za-z0-9:_-]+)/g)];
  if (nested.length) {
    const manifest = addFile(join(packageRoot, "package.json"), root, cwd, scratchRoots, files, limitations);
    if (!manifest) return;
    try {
      const scripts = (JSON.parse(manifest.content) as { scripts?: Record<string, unknown> }).scripts;
      for (const item of nested) {
        const next = scripts?.[item[1]];
        if (typeof next === "string") {
          if (/\bcd\s+/.test(next)) limitations.push(`Nested package script ${item[1]} changes directory; relative source resolution may be incomplete.`);
          collectReferencedSources(next, root, packageRoot, scratchRoots, files, limitations, depth + 1, packageRoot);
        }
        else limitations.push(`Nested package script ${item[1]} is not in the root manifest.`);
      }
    } catch { limitations.push("Could not parse the package manifest for nested script references."); }
  }
  if (!matches.length && !nested.length && /\b(?:node|tsx|ts-node|bun|deno|python3?|sh|bash)\b/.test(command)) {
    limitations.push("A script runner appears without a statically recognizable local source file.");
  }
}

function defaultConfigNames(tool: string): string[] {
  const prefix = tool === "playwright" ? "playwright" : tool;
  return ["ts", "js", "mjs", "cjs", "mts", "cts"].map(extension => `${prefix}.config.${extension}`);
}

function collectFlaggedConfigs(argv: string[], root: string, cwd: string, scratchRoots: string[], files: Map<string, PermissionEvidenceFile>, limitations: string[]) {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = arg.startsWith("--config=") ? arg.slice("--config=".length) : arg.startsWith("--project=") ? arg.slice("--project=".length) : ["--config", "--project"].includes(arg) ? argv[index + 1] : undefined;
    if (value && !value.startsWith("-")) addFile(value, root, cwd, scratchRoots, files, limitations);
  }
}

function looksLikeCommandSource(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return path === "package.json" || /(?:^|\/)(?:playwright|vitest|jest|vite|webpack|rollup|babel|tsconfig|eslint|prettier|postcss|tailwind)\.config\.[^/]+$/i.test(path) || RELEVANT_EXTENSIONS.has(extension);
}

function looksLikeChangedCommandDefinition(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return /(?:^|\/)package\.json$/i.test(normalized) || /(?:^|\/)(?:scripts|script|bin)\/[^/]+$/i.test(normalized) ||
    /(?:^|\/)(?:Makefile|GNUmakefile|justfile|Taskfile\.[^/]+|(?:playwright|vitest|jest|vite|webpack|rollup|babel|tsconfig|eslint|prettier|postcss|tailwind)\.config\.[^/]+)$/i.test(normalized);
}

function approvedScratchRoots(input: string[], cwd: string, limitations: string[]): string[] {
  const roots: string[] = [];
  const owner = statSync(cwd).uid;
  for (const value of input) {
    if (!isAbsolute(value) || resolve(value) !== value) {
      limitations.push("A host-approved scratch root is not an absolute canonical path.");
      continue;
    }
    try {
      const info = lstatSync(value);
      const real = realpathSync(value);
      if (info.isSymbolicLink() || !info.isDirectory() || real !== value || (info.uid !== owner && info.uid !== process.getuid?.() && info.uid !== 0) || within(value, cwd)) {
        limitations.push("A host-approved scratch root is not a trusted real directory outside the workspace ancestry.");
        continue;
      }
      if (!roots.includes(real)) roots.push(real);
    } catch {
      limitations.push("A host-approved scratch root could not be validated safely.");
    }
  }
  return roots;
}

function addFile(candidate: string, root: string, cwd: string, scratchRoots: string[], files: Map<string, PermissionEvidenceFile>, limitations: string[]): PermissionEvidenceFile | undefined {
  if (candidate.startsWith("-") || candidate.includes("\0")) { limitations.push("A source path is not a literal filesystem path."); return; }
  const resolved = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
  let base: string, display: string;
  if (within(root, resolved)) {
    base = root;
    display = relative(root, resolved).split(sep).join("/");
  } else {
    const scratchIndex = scratchRoots.findIndex(scratch => within(scratch, resolved));
    if (scratchIndex < 0) {
      limitations.push(`Source path ${safeDisplay(candidate)} is outside the repository or a host-approved scratch root.`);
      return;
    }
    base = scratchRoots[scratchIndex];
    display = `@scratch/${scratchIndex}/${relative(base, resolved).split(sep).join("/")}`;
  }
  const components = relative(base, resolved).split(sep).filter(Boolean);
  if (!components.length || components.some(part => part === ".." || EXCLUDED.test(part) || /(?:credential|secret|token|private|\.pem$|\.key$)/i.test(part))) {
    limitations.push(`Source path ${safeDisplay(display)} is excluded or unsafe to inspect.`);
    return;
  }
  const workspaceStat = statSync(cwd);
  let path = base;
  try {
    for (const component of components) {
      path = join(path, component);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) { limitations.push(`Source path ${safeDisplay(display)} traverses a symlink.`); return; }
    }
    const info = lstatSync(path);
    if (!info.isFile() || info.uid !== workspaceStat.uid) { limitations.push(`Source path ${safeDisplay(display)} is not a same-owner regular file.`); return; }
    if (info.size > MAX_FILE_BYTES) { limitations.push(`Source path ${safeDisplay(display)} exceeds the ${MAX_FILE_BYTES}-byte evidence limit and was omitted.`); return; }
    if (files.has(display)) return files.get(display);
    if (files.size >= MAX_FILES) { limitations.push(`The ${MAX_FILES}-file evidence limit was reached; source collection is incomplete.`); return; }
    const used = [...files.values()].reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    if (used + info.size > MAX_TOTAL_BYTES) { limitations.push(`The ${MAX_TOTAL_BYTES}-byte total evidence limit was reached; source collection is incomplete.`); return; }
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.uid !== workspaceStat.uid || opened.size !== info.size) {
        limitations.push(`Source path ${safeDisplay(display)} changed while evidence was collected.`); return;
      }
      const content = readFileSync(fd, "utf8");
      if (Buffer.byteLength(content) !== info.size || content.includes("\uFFFD")) { limitations.push(`Source path ${safeDisplay(display)} is not stable complete UTF-8 text.`); return; }
      const file = { path: display, content, sha256: createHash("sha256").update(content).digest("hex") };
      files.set(display, file);
      collectStaticLocalReferences(file, root, cwd, scratchRoots, files, limitations);
      return file;
    } finally { closeSync(fd); }
  } catch {
    limitations.push(`Source path ${safeDisplay(display)} could not be safely read as a regular file.`);
  }
}

function collectStaticLocalReferences(file: PermissionEvidenceFile, root: string, cwd: string, scratchRoots: string[], files: Map<string, PermissionEvidenceFile>, limitations: string[]) {
  if (!/\.(?:[cm]?[jt]sx?|sh|bash)$/i.test(file.path)) return;
  const refs = new Set<string>();
  const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g;
  for (const match of file.content.matchAll(imports)) refs.add(match[2]);
  const shellSources = /(?:^|[\s;])(?:source|\.)\s+(['"]?)(\.{1,2}\/[^\s'";]+)\1/gm;
  for (const match of file.content.matchAll(shellSources)) refs.add(match[2]);
  if (/\b(?:import|require)\s*\(?\s*(?:process\.env|`)/.test(file.content)) limitations.push(`File ${safeDisplay(file.path)} contains dynamic local source loading.`);
  const scratchMatch = /^@scratch\/(\d+)\/(.*)$/.exec(file.path);
  const parent = scratchMatch ? join(scratchRoots[Number(scratchMatch[1])] ?? root, scratchMatch[2]) : join(root, file.path);
  for (const ref of refs) {
    let candidate = resolve(dirname(parent), ref);
    if (!extname(candidate)) {
      const match = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".bash", ".py", ".json"].find(extension => existsRegular(candidate + extension));
      if (match) candidate += match;
      else if (existsRegular(join(candidate, "index.ts"))) candidate = join(candidate, "index.ts");
      else if (existsRegular(join(candidate, "index.js"))) candidate = join(candidate, "index.js");
      else { limitations.push(`Relative source reference in ${safeDisplay(file.path)} could not be resolved statically.`); continue; }
    }
    addFile(candidate, root, cwd, scratchRoots, files, limitations);
  }
}

function findRepositoryRoot(cwd: string): string {
  const realCwd = realpathSync(cwd);
  let current = realCwd;
  for (;;) {
    try { lstatSync(join(current, ".git")); return current; } catch { /* continue upward */ }
    const parent = dirname(current);
    if (parent === current) throw new Error("repository root not found");
    current = parent;
  }
}

function existsRegular(path: string): boolean { try { return lstatSync(path).isFile(); } catch { return false; } }
function within(base: string, path: string): boolean { const rel = relative(base, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); }
function safeDisplay(value: string): string { return value.replace(/[\r\n]/g, "?").slice(0, 180); }
