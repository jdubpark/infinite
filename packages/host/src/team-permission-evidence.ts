import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, closeSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Prompt } from "@infinite/attention";
import { dialogCommand } from "@infinite/attention";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 36 * 1024;
const MAX_REQUESTED_PATHS = 8;
const EXCLUDED = /^(?:\.git|node_modules|.*\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|private|\.local|id_rsa|id_ed25519|[^/]+\.(?:pem|key))$/i;
const TYPESCRIPT_SOURCES: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"], ".jsx": [".tsx"] };
const RELEVANT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".sh", ".bash", ".py", ".json", ".yaml", ".yml", ".toml", ".mk"]);
const SCRIPT_RUNNERS = new Set(["node", "tsx", "ts-node", "bun", "deno", "python", "python3", "sh", "bash"]);
const SAFE_PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);

export interface PermissionEvidenceFile {
  path: string;
  sha256: string;
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
  approvedScratchRoots?: string[];
  requestedPaths?: string[];
  root?: string;
}

export function collectPermissionEvidence(input: CollectPermissionEvidenceInput): PermissionEvidenceSnapshot {
  const limitations: string[] = [];
  const files = new Map<string, PermissionEvidenceFile>();
  let root: string;
  if (input.root !== undefined) {
    try { root = exactRoot(input.root); }
    catch { return snapshot(files, ["The session root is not a canonical directory."]); }
  } else {
    try { root = findRepositoryRoot(input.cwd); }
    catch { return snapshot(files, ["Could not identify a real repository root for the target workspace."]); }
  }
  const cwd = realpathSync(input.cwd);
  if (input.root !== undefined && !within(root, cwd)) return snapshot(files, ["The working directory is outside the session root."]);
  const scratchRoots = approvedScratchRoots(input.approvedScratchRoots ?? [], cwd, limitations);

  const command = completeCommand(input.prompt, limitations);
  const commands = command ? splitLiteralCommandChain(command, limitations) : undefined;
  if (commands) for (const part of commands) {
    const tokens = tokenize(part, limitations);
    if (tokens?.words.length) collectCommandEvidence(tokens.words, tokens.environmentAssignments, root, cwd, scratchRoots, input.changedPaths, files, limitations);
  }
  collectRequestedPaths(input.requestedPaths ?? [], root, cwd, scratchRoots, files, limitations);
  for (const path of input.changedPaths) {
    if (looksLikeChangedCommandDefinition(path)) addFile(path, root, cwd, scratchRoots, files, limitations);
  }
  return snapshot(files, limitations);
}

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

const OUTPUT_FILTERS = new Set(["head", "tail", "grep", "egrep", "fgrep", "rg", "wc", "sort", "uniq", "cut", "tr", "cat", "nl"]);
const HEAD_TAIL_BOOL_FLAGS = new Set(["-q", "--quiet", "--silent", "-v", "--verbose", "-z", "--zero-terminated"]);
const HEAD_TAIL_VALUE_FLAGS = new Set(["-n", "--lines", "-c", "--bytes"]);
const WC_BOOL_FLAGS = new Set(["-l", "--lines", "-w", "--words", "-c", "--bytes", "-m", "--chars", "-L", "--max-line-length"]);
const CAT_BOOL_FLAGS = new Set(["-A", "--show-all", "-b", "--number-nonblank", "-e", "-E", "--show-ends", "-n", "--number", "-s", "--squeeze-blank", "-t", "-T", "--show-tabs", "-u", "-v", "--show-nonprinting"]);
const NL_BOOL_FLAGS = new Set(["-p", "--no-renumber"]);
const NL_VALUE_FLAGS = new Set(["-b", "--body-numbering", "-h", "--header-numbering", "-f", "--footer-numbering", "-d", "--section-delimiter", "-i", "--line-increment", "-l", "--join-blank-lines", "-n", "--number-format", "-s", "--number-separator", "-v", "--starting-line-number", "-w", "--number-width"]);
const SORT_BOOL_FLAGS = new Set(["-b", "--ignore-leading-blanks", "-d", "--dictionary-order", "-f", "--ignore-case", "-g", "--general-numeric-sort", "-i", "--ignore-nonprinting", "-M", "--month-sort", "-h", "--human-numeric-sort", "-n", "--numeric-sort", "-R", "--random-sort", "-r", "--reverse", "-V", "--version-sort", "-c", "--check", "-C", "-m", "--merge", "-s", "--stable", "-u", "--unique", "-z", "--zero-terminated"]);
const SORT_VALUE_FLAGS = new Set(["-k", "--key", "-t", "--field-separator", "-S", "--buffer-size", "--parallel"]);
const UNIQ_BOOL_FLAGS = new Set(["-c", "--count", "-d", "--repeated", "-D", "-u", "--unique", "-i", "--ignore-case", "-z", "--zero-terminated", "--all-repeated", "--group"]);
const UNIQ_VALUE_FLAGS = new Set(["-f", "--skip-fields", "-s", "--skip-chars", "-w", "--check-chars"]);
const UNIQ_INLINE_ONLY_FLAGS = new Set(["--all-repeated", "--group"]);
const CUT_BOOL_FLAGS = new Set(["-s", "--only-delimited", "-z", "--zero-terminated", "--complement", "-n"]);
const CUT_VALUE_FLAGS = new Set(["-b", "--bytes", "-c", "--characters", "-d", "--delimiter", "-f", "--fields", "--output-delimiter"]);
const TR_BOOL_FLAGS = new Set(["-c", "-C", "--complement", "-d", "--delete", "-s", "--squeeze-repeats", "-t", "--truncate-set1"]);
const GREP_COMMON_BOOL_FLAGS = new Set(["-E", "-F", "-G", "-P", "-i", "-v", "-w", "-x", "-c", "-l", "-L", "-n", "-h", "-H", "-o", "-q", "-s", "-b", "-u", "-z", "-a", "-I", "--extended-regexp", "--fixed-strings", "--basic-regexp", "--perl-regexp", "--ignore-case", "--invert-match", "--word-regexp", "--line-regexp", "--count", "--files-with-matches", "--files-without-match", "--line-number", "--no-filename", "--with-filename", "--only-matching", "--quiet", "--silent", "--no-messages", "--byte-offset", "--null-data", "--text", "--line-buffered"]);
const GREP_ONLY_BOOL_FLAGS = new Set(["-T", "--initial-tab", "--color", "--colour"]);
const GREP_INLINE_ONLY_FLAGS = new Set(["--color", "--colour"]);
const GREP_COMMON_VALUE_FLAGS = new Set(["-e", "--regexp", "-A", "--after-context", "-B", "--before-context", "-C", "--context", "-m", "--max-count"]);
const RG_ONLY_BOOL_FLAGS = new Set(["--smart-case", "-S", "--case-sensitive", "--no-heading", "--no-line-number", "--vimgrep", "--json"]);
const RG_ONLY_VALUE_FLAGS = new Set(["--color", "--colour", "-M", "--max-columns", "-t", "--type", "-T", "--type-not"]);

function matchLongValueFlag(arg: string, flags: ReadonlySet<string>): { name: string; inlineValue?: string } | undefined {
  if (flags.has(arg)) return { name: arg };
  const eq = arg.indexOf("=");
  if (eq <= 0) return undefined;
  const name = arg.slice(0, eq);
  return flags.has(name) ? { name, inlineValue: arg.slice(eq + 1) } : undefined;
}

function isSafeOutputFilterStage(stage: string): boolean {
  const tokens = tokenize(stage, []);
  if (!tokens || !tokens.words.length || tokens.environmentAssignments.some(Boolean)) return false;
  const rawExec = tokens.words[0];
  if (/[\\/]/.test(rawExec)) return false;
  const exec = /\.cmd$/i.test(rawExec) ? rawExec.slice(0, -4).toLowerCase() : rawExec;
  if (!OUTPUT_FILTERS.has(exec)) return false;
  const args = tokens.words.slice(1);
  let afterDoubleDash = false;
  let positionals = 0;
  let hasExplicitPattern = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (afterDoubleDash || !arg.startsWith("-") || arg === "-") {
      if (arg === "-") return false;
      positionals++;
      continue;
    }
    if (exec === "head" || exec === "tail") {
      if (HEAD_TAIL_BOOL_FLAGS.has(arg) || /^-[0-9]+$/.test(arg) || /^-[nc]\+?[0-9]+[bkmgtpezyBKMGTP]*$/.test(arg)) continue;
      const valFlag = matchLongValueFlag(arg, HEAD_TAIL_VALUE_FLAGS);
      if (!valFlag) return false;
      const value = valFlag.inlineValue ?? args[++i];
      if (!value || !/^\+?[0-9]+[bkmgtpezyBKMGTP]*$/.test(value)) return false;
      continue;
    }
    if (exec === "wc") {
      if (!WC_BOOL_FLAGS.has(arg) && !/^-[lwcmL]+$/.test(arg)) return false;
      continue;
    }
    if (exec === "cat") {
      if (!CAT_BOOL_FLAGS.has(arg) && !/^-[AbeEnstTuv]+$/.test(arg)) return false;
      continue;
    }
    if (exec === "nl") {
      if (NL_BOOL_FLAGS.has(arg)) continue;
      const valFlag = matchLongValueFlag(arg, NL_VALUE_FLAGS);
      if (!valFlag) return false;
      if (valFlag.inlineValue === undefined && args[++i] === undefined) return false;
      continue;
    }
    if (exec === "sort") {
      if (SORT_BOOL_FLAGS.has(arg) || /^-[bdfgiMhnRrVcmsuz]+$/.test(arg)) continue;
      const valFlag = matchLongValueFlag(arg, SORT_VALUE_FLAGS);
      if (!valFlag) return false;
      if (valFlag.inlineValue === undefined && args[++i] === undefined) return false;
      continue;
    }
    if (exec === "uniq") {
      if (UNIQ_BOOL_FLAGS.has(arg) || /^-[cdDiuwz]+$/.test(arg)) continue;
      const inlineFlag = matchLongValueFlag(arg, UNIQ_INLINE_ONLY_FLAGS);
      if (inlineFlag?.inlineValue !== undefined) continue;
      const valFlag = matchLongValueFlag(arg, UNIQ_VALUE_FLAGS);
      if (!valFlag) return false;
      if (valFlag.inlineValue === undefined && args[++i] === undefined) return false;
      continue;
    }
    if (exec === "cut") {
      if (CUT_BOOL_FLAGS.has(arg)) continue;
      if (/^-[bcdf].+$/.test(arg)) continue;
      const valFlag = matchLongValueFlag(arg, CUT_VALUE_FLAGS);
      if (!valFlag) return false;
      if (valFlag.inlineValue === undefined && args[++i] === undefined) return false;
      continue;
    }
    if (exec === "tr") {
      if (!TR_BOOL_FLAGS.has(arg) && !/^-[cCdst]+$/.test(arg)) return false;
      continue;
    }
    if (GREP_COMMON_BOOL_FLAGS.has(arg)
      || (exec === "rg" ? RG_ONLY_BOOL_FLAGS.has(arg) || /^-[EFGPivwxclLnhHoqsbuzSa]+$/.test(arg)
        : GREP_ONLY_BOOL_FLAGS.has(arg) || /^-[EFGPivwxclLnhHoqsbuzT]+$/.test(arg))) {
      continue;
    }
    if (exec !== "rg") {
      const inlineFlag = matchLongValueFlag(arg, GREP_INLINE_ONLY_FLAGS);
      if (inlineFlag?.inlineValue !== undefined) continue;
    }
    if (/^-[ABCm][0-9]+$/.test(arg)) continue;
    if (/^-e.+$/.test(arg)) { hasExplicitPattern = true; continue; }
    const valFlag = matchLongValueFlag(arg, GREP_COMMON_VALUE_FLAGS)
      ?? (exec === "rg" ? matchLongValueFlag(arg, RG_ONLY_VALUE_FLAGS) : undefined);
    if (!valFlag) return false;
    if (valFlag.name === "-e" || valFlag.name === "--regexp") hasExplicitPattern = true;
    if (valFlag.inlineValue === undefined && args[++i] === undefined) return false;
  }
  if (exec === "tr") return positionals >= 1 && positionals <= 2;
  if (exec === "grep" || exec === "egrep" || exec === "fgrep" || exec === "rg") {
    return hasExplicitPattern ? positionals === 0 : positionals === 1;
  }
  return positionals === 0;
}

function splitPipeStages(segment: string): string[] | undefined {
  const stages: string[] = [];
  let start = 0, quote: "'" | '"' | undefined, escaped = false;
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "|") {
      const next = segment[index + 1];
      if (next === "|" || next === "&") return undefined;
      const part = segment.slice(start, index).trim();
      if (!part) return undefined;
      stages.push(part);
      start = index + 1;
    }
  }
  const final = segment.slice(start).trim();
  if (!final) return undefined;
  stages.push(final);
  return stages;
}

function splitLiteralCommandChain(command: string, limitations: string[]): string[] | undefined {
  if (/[\n\r\0]/.test(command) || /[;<>`]/.test(command) || /\$\(|\$\{|\$[A-Za-z_]/.test(command)) {
    limitations.push("The command uses shell composition, expansion, or multiple lines; source collection is incomplete.");
    return undefined;
  }
  const rawParts: string[] = [];
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
      rawParts.push(part);
      start = ++index + 1;
    }
  }
  if (quote || escaped) { limitations.push("The command contains an unterminated quote or escape."); return undefined; }
  const final = command.slice(start).trim();
  if (!final) { limitations.push("The shell command chain ends without a command."); return undefined; }
  rawParts.push(final);
  const parts: string[] = [];
  for (const segment of rawParts) {
    const stages = splitPipeStages(segment);
    if (!stages) {
      limitations.push("The command uses shell composition, expansion, or multiple lines; source collection is incomplete.");
      return undefined;
    }
    for (let index = 1; index < stages.length; index++) {
      if (!isSafeOutputFilterStage(stages[index])) {
        limitations.push("The command uses shell composition, expansion, or multiple lines; source collection is incomplete.");
        return undefined;
      }
    }
    parts.push(stages[0]);
  }
  return parts;
}

interface TokenizedCommand {
  words: string[];
  environmentAssignments: boolean[];
}

function tokenize(command: string, limitations: string[]): TokenizedCommand | undefined {
  if (/[\n\r\0]/.test(command) || /[|;&<>`]/.test(command) || /\$\(|\$\{|\$[A-Za-z_]/.test(command)) {
    limitations.push("The command segment uses unsupported shell syntax.");
    return undefined;
  }
  const words: string[] = [];
  const environmentAssignments: boolean[] = [];
  let word = "", quote: "'" | '"' | undefined, escaped = false, started = false;
  let assignmentName = "", assignmentPrefixValid = true, assignmentEquals = false;
  const resetWord = () => {
    word = "";
    started = false;
    assignmentName = "";
    assignmentPrefixValid = true;
    assignmentEquals = false;
  };
  const observeUnquotedCharacter = (char: string) => {
    if (!assignmentPrefixValid || assignmentEquals) return;
    if (char === "=") {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(assignmentName)) assignmentEquals = true;
      else assignmentPrefixValid = false;
      return;
    }
    assignmentName += char;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(assignmentName)) assignmentPrefixValid = false;
  };
  const finishWord = () => {
    words.push(word);
    environmentAssignments.push(assignmentPrefixValid && assignmentEquals);
    resetWord();
  };
  for (const char of command.trim()) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "'") {
      if (!assignmentEquals) assignmentPrefixValid = false;
      escaped = true; started = true; continue;
    }
    if (quote) { if (char === quote) quote = undefined; else word += char; started = true; continue; }
    if (char === "'" || char === '"') {
      if (!assignmentEquals) assignmentPrefixValid = false;
      quote = char; started = true; continue;
    }
    if (/\s/.test(char)) { if (started) finishWord(); continue; }
    observeUnquotedCharacter(char);
    word += char; started = true;
  }
  if (escaped || quote) { limitations.push("The command contains an unterminated quote or escape."); return undefined; }
  if (started) finishWord();
  if (!words.length || words.some(word => /[*?\[\]]/.test(word))) {
    limitations.push("The command is not a single literal executable invocation.");
    return undefined;
  }
  return { words, environmentAssignments };
}

function collectRequestedPaths(requestedPaths: string[], root: string, cwd: string, scratchRoots: string[], files: Map<string, PermissionEvidenceFile>, limitations: string[]) {
  const limit = Math.min(requestedPaths.length, MAX_REQUESTED_PATHS);
  for (let index = 0; index < limit; index++) {
    const candidate = requestedPaths[index];
    if (typeof candidate !== "string") {
      limitations.push(`Coordinator-requested source path ${index + 1} is not a string.`);
      continue;
    }
    addFile(candidate, root, cwd, scratchRoots, files, limitations);
  }
  if (requestedPaths.length > MAX_REQUESTED_PATHS) {
    const omitted = createHash("sha256").update(String(requestedPaths.length - MAX_REQUESTED_PATHS)).update("\0");
    for (let index = MAX_REQUESTED_PATHS; index < requestedPaths.length; index++) {
      const candidate = requestedPaths[index];
      omitted.update(typeof candidate === "string" ? candidate : String(candidate)).update("\0");
    }
    limitations.push(`Coordinator-requested source paths exceed the ${MAX_REQUESTED_PATHS}-path limit; ${requestedPaths.length - MAX_REQUESTED_PATHS} additional path(s) were not inspected (sha256 ${omitted.digest("hex")}).`);
  }
}

function stripLiteralEnvironmentAssignments(argv: string[], environmentAssignments: boolean[], limitations: string[]): string[] | undefined {
  let index = 0;
  while (index < argv.length && environmentAssignments[index]) index++;
  if (!index) return argv;
  if (index === argv.length) {
    limitations.push("The command contains literal environment assignments but no executable.");
    return undefined;
  }
  return argv.slice(index);
}

const STATIC_TOOL_RUNNERS = new Set(["playwright", "vitest", "jest", "vite", "webpack", "rollup"]);

function collectCommandEvidence(argv: string[], environmentAssignments: boolean[], root: string, cwd: string, scratchRoots: string[], changedPaths: string[], files: Map<string, PermissionEvidenceFile>, limitations: string[]) {
  const unwrapped = stripLiteralEnvironmentAssignments(argv, environmentAssignments, limitations);
  if (!unwrapped?.length) return;
  argv = unwrapped;
  const executable = basename(argv[0]).replace(/\.cmd$/i, "").toLowerCase();
  if (executable === "npx") {
    const runner = argv[1] ?? "";
    if (STATIC_TOOL_RUNNERS.has(runner)) collectStaticToolEvidence(runner, argv.slice(2), root, cwd, root, scratchRoots, files, limitations);
    else limitations.push("The npx command does not name a supported static local tool runner.");
    return;
  }
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
  if (STATIC_TOOL_RUNNERS.has(executable)) {
    collectStaticToolEvidence(executable, argv.slice(1), root, cwd, root, scratchRoots, files, limitations);
    return;
  }
  if (executable === "git") {
    return;
  }
  limitations.push(`No supported static source mapping is defined for executable ${executable || "(empty)"}.`);
  for (const path of changedPaths) if (looksLikeCommandSource(path)) addFile(path, root, cwd, scratchRoots, files, limitations);
}

function collectStaticToolEvidence(tool: string, args: string[], root: string, cwd: string, configRoot: string, scratchRoots: string[], files: Map<string, PermissionEvidenceFile>, limitations: string[]) {
  const manifest = join(configRoot, "package.json");
  if (existsRegular(manifest)) addFile(manifest, root, cwd, scratchRoots, files, limitations);
  for (const name of defaultConfigNames(tool)) if (existsRegular(join(configRoot, name))) addFile(join(configRoot, name), root, cwd, scratchRoots, files, limitations);
  const testPath = args.find(arg => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(arg));
  if (testPath) addFile(testPath, root, cwd, scratchRoots, files, limitations);
  else if (["playwright", "vitest", "jest"].includes(tool)) limitations.push("The test runner did not name an explicit test file; default test discovery is not part of this source snapshot.");
  collectFlaggedConfigs(args, root, cwd, scratchRoots, files, limitations);
}

function collectPackageCommand(manager: string, args: string[], root: string, cwd: string, scratchRoots: string[], files: Map<string, PermissionEvidenceFile>, limitations: string[]) {
  const boundary = args.indexOf("--");
  const options = boundary < 0 ? args : args.slice(0, boundary);
  if (options.some(arg => /^(?:--(?:filter|prefix|dir|cwd|workspaces|global|recursive)(?:=|$)|-[CrgW])/.test(arg) || arg === "workspace") ||
      manager !== "npm" && options.some(arg => /^--workspace(?:=|$)|^-w/.test(arg))) {
    limitations.push(`The ${manager} directory or workspace selection is not mapped to one local manifest.`);
    return;
  }
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
  const verb = args[commandIndex];
  if (manager === "npm" && verb === "exec") {
    const execArgs = args.slice(commandIndex + 1);
    if (commandIndex !== 0 || execArgs[0] !== "--") {
      limitations.push("Only plain npm exec -- <supported runner> is mapped; npm exec package or command-selection flags are unsupported.");
      return;
    }
    const runner = execArgs[1] ?? "";
    if (!STATIC_TOOL_RUNNERS.has(runner)) {
      limitations.push("The npm exec command does not name a supported static local tool runner.");
      return;
    }
    collectStaticToolEvidence(runner, execArgs.slice(2), root, packageRoot, packageRoot, scratchRoots, files, limitations);
    return;
  }
  const rootManifest = addFile("package.json", root, cwd, scratchRoots, files, limitations);
  if (commandIndex < 0) {
    limitations.push(`The ${manager} command does not name a statically inspectable script entrypoint.`);
    return;
  }
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
    const sourceExtensions = TYPESCRIPT_SOURCES[extname(candidate)];
    if (sourceExtensions && !existsRegular(candidate)) {
      const source = sourceExtensions.map(extension => candidate.slice(0, -extname(candidate).length) + extension).find(existsRegular);
      if (source) candidate = source;
    }
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
    try { lstatSync(join(current, ".git")); return current; } catch {}
    const parent = dirname(current);
    if (parent === current) throw new Error("repository root not found");
    current = parent;
  }
}

function exactRoot(path: string): string {
  if (!isAbsolute(path) || realpathSync(path) !== path || !statSync(path).isDirectory()) throw new Error("The root is not a canonical directory.");
  return path;
}

function existsRegular(path: string): boolean { try { return lstatSync(path).isFile(); } catch { return false; } }
function within(base: string, path: string): boolean { const rel = relative(base, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); }
function safeDisplay(value: string): string { return value.replace(/[\r\n]/g, "?").slice(0, 180); }
