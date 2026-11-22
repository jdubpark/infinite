/**
 * The permission agent's host rules: the class rules that send a request to the owner, the qualify
 * step, and the raise rules that select the strong tier. A host rule never allows a request. The host's
 * lists are data in one place (`PERMISSION_CLASS_LISTS`), so a change to a list is visible in review and
 * makes every replay result stale (it is part of `classRulesDigest`).
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { matchDestructive } from "@infinite/attention";
import type { PermissionClassMatch, PermissionQualification, PermissionRequest } from "./permission-agent-types.js";
import type { InterruptClass } from "./permission-policy.js";
import { canonicalJson } from "./evidence/crypto.js";
import { MAX_SHELL_DEPTH, quoteWord, readShell, remoteOperand, resolveWord, type PathResolver, type SimpleCommand } from "./permission-shell.js";

/** Bumped by any change to the rule code below, or to the shell reading it uses, that is not a change to the lists. */
export const CLASS_RULES_VERSION = 8;

/**
 * The host's lists. Commands are word prefixes after wrappers (sudo, env, timeout) are removed; option
 * words between a program and its subcommand words do not hide them (`runsPattern`). Paths
 * are segment sequences that match anywhere in a resolved path, so they do not depend on whose home
 * directory a session uses.
 */
export const PERMISSION_CLASS_LISTS = {
  /** Production or staging: the host's own release tooling. Workspace delivery commands come with the request. */
  hostReleaseCommands: [
    ["systemctl", "restart", "infinite*"], ["systemctl", "start", "infinite*"], ["systemctl", "stop", "infinite*"],
    ["systemctl", "reload", "infinite*"], ["systemctl", "enable", "infinite*"], ["systemctl", "disable", "infinite*"],
    ["systemctl", "link", "infinite*"], ["systemctl", "mask", "infinite*"], ["systemctl", "unmask", "infinite*"],
    ["systemctl", "edit", "infinite*"], ["systemctl", "kill", "infinite*"],
  ],
  /** New or external credentials: login, token creation and key import. */
  credentialCommands: [
    ["gh", "auth", "login"], ["gh", "auth", "refresh"], ["gh", "auth", "token"], ["gh", "auth", "setup-git"],
    ["gh", "ssh-key", "add"], ["gh", "gpg-key", "add"], ["gh", "secret", "set"], ["gh", "variable", "set"],
    ["npm", "login"], ["npm", "adduser"], ["npm", "token", "create"], ["pnpm", "login"], ["yarn", "npm", "login"],
    ["docker", "login"], ["podman", "login"], ["helm", "registry", "login"],
    ["aws", "configure"], ["aws", "sso", "login"], ["aws", "iam", "create-access-key"], ["aws", "sts", "get-session-token"],
    ["gcloud", "auth"], ["gcloud", "iam", "service-accounts", "keys", "create"], ["az", "login"], ["az", "ad", "sp", "create-for-rbac"],
    ["firebase", "login"], ["vercel", "login"], ["netlify", "login"], ["heroku", "login"], ["heroku", "auth:token"],
    ["eas", "login"], ["expo", "login"], ["wrangler", "login"], ["fly", "auth"], ["flyctl", "auth"], ["railway", "login"],
    ["op", "signin"], ["op", "item", "create"], ["vault", "login"], ["vault", "token", "create"], ["bw", "login"], ["bw", "unlock"],
    ["ssh-keygen"], ["ssh-add"], ["ssh-copy-id"], ["gpg", "--import"], ["gpg", "--gen-key"], ["gpg", "--full-generate-key"],
    ["gpg", "--quick-generate-key"], ["gpg", "--export-secret-keys"], ["security", "import"], ["security", "add-generic-password"],
    ["security", "add-internet-password"], ["security", "find-generic-password"], ["security", "find-internet-password"],
    ["security", "dump-keychain"], ["git", "credential"], ["git", "credential-store"], ["git", "credential-cache"],
    ["codex", "login"], ["claude", "setup-token"], ["claude", "login"], ["opencode", "auth"], ["opencode", "providers", "login"],
    ["cargo", "login"], ["gem", "signin"], ["poetry", "config", "pypi-token*"], ["twine", "register"],
    ["kubectl", "config", "set-credentials"], ["pass", "insert"], ["pass", "generate"], ["keyring", "set"],
  ],
  /**
   * Options of the programs these lists name that take the next word as their value, so the value is not
   * read as a subcommand (`aws --profile p configure`). A word after any other option written without `=`
   * may also be a value: a subcommand behind one is raised, not classed.
   */
  valuedGlobalOptions: {
    git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"],
    npm: ["-C", "--prefix", "--registry", "--userconfig", "--globalconfig", "--cache", "--loglevel", "-w", "--workspace", "--scope", "--otp", "--auth-type", "--tag", "--access", "--location"],
    pnpm: ["-C", "--dir", "-F", "--filter", "--registry", "--loglevel", "--reporter", "--workspace-dir"],
    yarn: ["--cwd", "--registry"],
    gh: ["-R", "--repo", "--hostname"],
    docker: ["--config", "-c", "--context", "-H", "--host", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"],
    podman: ["-c", "--connection", "--url", "--identity", "--root", "--runroot", "--log-level", "--storage-driver", "--runtime", "--tmpdir"],
    helm: ["--kube-context", "--kubeconfig", "-n", "--namespace", "--registry-config", "--repository-config", "--repository-cache", "--kube-apiserver", "--kube-token"],
    aws: ["--profile", "--region", "--output", "--endpoint-url", "--query", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout", "--color", "--cli-binary-format"],
    gcloud: ["--project", "--account", "--configuration", "--verbosity", "--impersonate-service-account", "--billing-project", "--format", "--flags-file", "--trace-token"],
    az: ["--subscription", "-o", "--output", "--query"],
    firebase: ["-P", "--project", "--token", "-c", "--config", "--account"],
    vercel: ["-t", "--token", "-S", "--scope", "--cwd", "-Q", "--global-config", "-A", "--local-config", "-T", "--team"],
    netlify: ["--auth", "--filter"],
    heroku: ["-a", "--app", "-r", "--remote"],
    wrangler: ["-c", "--config", "-e", "--env", "--cwd"],
    fly: ["-a", "--app", "-c", "--config", "-t", "--access-token"],
    flyctl: ["-a", "--app", "-c", "--config", "-t", "--access-token"],
    op: ["--account", "--config", "--session", "--encoding", "--format"],
    bw: ["--session"],
    gpg: ["--homedir", "--keyring", "--default-key", "-u", "--local-user", "-r", "--recipient", "-o", "--output", "--passphrase", "--passphrase-file", "--pinentry-mode", "--keyserver"],
    codex: ["-c", "--config", "-m", "--model", "-p", "--profile", "-C", "--cd", "-s", "--sandbox", "-a", "--ask-for-approval"],
    claude: ["--model", "--settings", "--add-dir", "--mcp-config", "--permission-mode", "--output-format", "--input-format", "--setting-sources", "--session-id", "--fallback-model", "--append-system-prompt"],
    opencode: ["--log-level", "-m", "--model"],
    cargo: ["--config", "-Z", "--color"],
    poetry: ["-C", "--directory", "-P", "--project"],
    kubectl: ["--kubeconfig", "--context", "--cluster", "--user", "-n", "--namespace", "-s", "--server", "--token", "--as", "--as-group", "--request-timeout"],
    doctl: ["-t", "--access-token", "--context", "-c", "--config", "-o", "--output", "-u", "--api-url"],
    systemctl: ["-H", "--host", "-M", "--machine", "--root", "-t", "--type", "-p", "--property", "-s", "--signal", "--state", "--kill-whom", "-n", "--lines", "-o", "--output", "--job-mode"],
    defaults: ["-host"],
  },
  /** Credential store locations. A read or write of one outside the session root is the credentials class. */
  credentialPaths: [
    ".ssh", ".aws", ".azure", ".config/gcloud", ".config/gh", ".config/hub", ".docker/config.json", ".npmrc", ".netrc",
    ".git-credentials", ".gnupg", ".kube", ".pypirc", ".gem/credentials", ".cargo/credentials", ".cargo/credentials.toml",
    ".password-store", "Library/Keychains", ".codex/auth.json", ".claude/.credentials.json", ".local/share/opencode/auth.json",
    ".config/op", ".terraform.d/credentials.tfrc.json", ".vault-token", ".config/infinite", "etc/ssl/private", "etc/shadow",
  ],
  /** Money: payment, billing and purchase commands. */
  paymentCommands: [
    ["stripe"], ["gcloud", "billing"], ["gcloud", "beta", "billing"], ["gcloud", "alpha", "billing"],
    ["gcloud", "domains", "registrations", "register"], ["aws", "route53domains", "register-domain"],
    ["aws", "route53domains", "transfer-domain-in"], ["aws", "route53domains", "renew-domain"], ["aws", "budgets"],
    ["aws", "billing"], ["aws", "marketplace-catalog"], ["az", "billing"], ["vercel", "domains", "buy"], ["vercel", "billing"],
    ["doctl", "billing-history"], ["mas", "purchase"], ["mas", "install"],
  ],
  /** Money: MCP servers whose tools are payment or billing tools. */
  paymentToolServers: ["stripe", "paypal", "square", "braintree", "adyen", "paddle", "lemonsqueezy", "chargebee", "recurly", "gocardless", "mollie", "razorpay"],
  /** Money: payment and billing endpoints. A leading dot matches every subdomain. */
  paymentHosts: [
    "api.stripe.com", "checkout.stripe.com", "billing.stripe.com", "connect.stripe.com", "api.paypal.com", "api-m.paypal.com",
    "connect.squareup.com", "api.squareup.com", "payments.braintree-api.com", "api.braintreegateway.com", "api.paddle.com",
    "vendors.paddle.com", "api.lemonsqueezy.com", ".chargebee.com", ".recurly.com", "api.gocardless.com", "api.mollie.com",
    "api.razorpay.com", "cloudbilling.googleapis.com", "billingbudgets.googleapis.com", "budgets.amazonaws.com",
  ],
  /** Global or account settings: host and system locations whose change is a change to host configuration. */
  hostProtectedPaths: [
    "/etc", "/opt/infinite", "/opt/infinite-releases", "/opt/infinite-agents", "/usr/local/libexec/infinite",
    "/Library/LaunchDaemons", "/Library/LaunchAgents", "/Library/Preferences",
  ],
  /** Global or account settings: provider and tool settings outside the session root. */
  settingsPaths: [
    ".claude", ".claude.json", ".codex", ".config", ".local/share/opencode", ".opencode", ".gitconfig", ".yarnrc", ".yarnrc.yml",
    ".bashrc", ".bash_profile", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".vimrc", ".tmux.conf", ".cursor",
    ".vscode", ".gemini", "Library/Preferences", "Library/LaunchAgents", "Library/Application Support",
  ],
  /** Global or account settings: a provider settings file, a hook or an MCP configuration inside the session root. */
  providerSettingsInRoot: [
    ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks", ".claude/agents", ".mcp.json", ".codex",
    "opencode.json", "opencode.jsonc", ".opencode", ".cursor/mcp.json", ".vscode/mcp.json", ".gemini/settings.json",
    ".git/hooks", ".git/config",
  ],
  /** Raise only: any other settings file inside the session root. Dot-rc and dot-env files are added by pattern. */
  settingsInRoot: [
    ".claude", ".npmrc", ".yarnrc.yml", ".vscode", ".idea", ".husky", ".pre-commit-config.yaml", "lefthook.yml",
    ".github/workflows", ".devcontainer", ".envrc", ".tool-versions", ".git",
  ],
} as const;

/** Paths that are never a target. */
const DEVICE_PATHS = /^\/dev\/(?:null|zero|random|urandom|stdin|stdout|stderr|tty|fd\/\d+)$/;
const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "base64", "xxd", "od", "hexdump", "strings", "wc", "diff", "cmp", "file", "stat", "ls", "find", "jq", "yq", "sort", "uniq", "cut", "nl", "bat", "tac", "md5sum", "sha256sum", "shasum", "readlink", "realpath", "du", "tree"]);
const WRITE_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "touch", "mkdir", "chmod", "chown", "chgrp", "tee", "dd", "chattr", "setfacl"]);
const COPY_COMMANDS = new Set(["cp", "mv", "install", "rsync", "ln", "scp"]);
/** Commands whose every operand is a path. For other commands only words that look like paths count. */
const PATH_COMMANDS = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, ...COPY_COMMANDS, "sed", "awk", "source", "."]);
const SHELL_TOOLS = new Set(["bash", "shell", "exec_command", "local_shell", "unified_exec", "dialog", "exec", "run_command", "terminal"]);
const READ_TOOL = /^(?:read|view|glob|grep|ls|list|search|find|notebookread|webfetch)$/i;
const WRITE_TOOL = /(?:write|edit|patch|create|delete|remove|move|rename|notebookedit)/i;

type Access = "read" | "write" | "unknown";
interface Target { path: string; access: Access; word: string }

/** What the host establishes about one request. It is computed once for the class and raise rules. */
export interface RequestReading {
  commands: SimpleCommand[];
  targets: Target[];
  urls: URL[];
  opaque: boolean;
  opaqueReasons: string[];
  shell: boolean;
  tool: string;
  /** Path words the host could not resolve (a variable or another user's home). */
  unresolved: string[];
  /** The resolver the targets were read through. The rules read every further path through it. */
  resolve?: PathResolver;
}

export interface HostRuleFacts {
  /** Absolute host paths a write to which changes host configuration: config, state, run and install directories, launchers. */
  protectedPaths?: readonly string[];
  /** Further host release commands, as words. */
  releaseCommands?: readonly (readonly string[])[];
}

/** A digest of everything the class rules depend on. A change makes every replay result stale. */
export function classRulesDigest(facts: HostRuleFacts = {}): string {
  return createHash("sha256").update(canonicalJson({
    version: CLASS_RULES_VERSION,
    lists: PERMISSION_CLASS_LISTS,
    protectedPaths: [...(facts.protectedPaths ?? [])].sort(),
    releaseCommands: (facts.releaseCommands ?? []).map(words => [...words]),
  })).digest("hex");
}

export function qualify(request: PermissionRequest): PermissionQualification {
  if (!request.shape.completeEvidence) return { qualified: false, reason: "incomplete-evidence" };
  if (!request.shape.oneShotAccept) return { qualified: false, reason: "no-one-shot-accept" };
  if (!request.shape.oneShotReject) return { qualified: false, reason: "no-one-shot-reject" };
  return { qualified: true };
}

/**
 * The request as the host rules read it under a resolver: the session and scratch roots as real paths.
 * A root the host cannot read stays as written, so its real targets count as outside it.
 */
export function withRealRoots(request: PermissionRequest, real: PathResolver): PermissionRequest {
  const requester = request.requester;
  return { ...request, requester: { ...requester, sessionRoot: real(requester.sessionRoot) ?? requester.sessionRoot, scratchRoots: requester.scratchRoots.map(root => real(root) ?? root) } };
}

/**
 * `resolvePath` makes every path a real host path (see `realHostPath`); the caller passes the request
 * from `withRealRoots`. Without it paths are read as written, which is what a replay does. `depth` is
 * the shell layer the command line is at, for a line the embedded-command rule found inside another.
 */
export function readRequest(request: PermissionRequest, resolvePath?: PathResolver, depth = 0): RequestReading {
  const tool = request.tool;
  const input = request.input ?? {};
  const root = request.requester.sessionRoot;
  const targets: Target[] = [];
  const unresolved: string[] = [];
  const reasons = new Set<string>();
  // A path the host cannot read keeps its written form, and the request is opaque: the strong tier decides.
  const real: PathResolver | undefined = resolvePath && (path => {
    const found = resolvePath(path);
    if (found === undefined) reasons.add("unreadable-path");
    return found;
  });
  const cwdInput = typeof input.workdir === "string" ? input.workdir : typeof input.cwd === "string" ? input.cwd : undefined;
  const cwd = cwdInput ? resolveWord(cwdInput, root, real) ?? root : root;
  const commands: SimpleCommand[] = [];
  const add = (word: string, access: Access, base: string | undefined) => {
    const written = resolveWord(word, base);
    if (written === undefined) { unresolved.push(word); return; }
    // A device is judged as written: its real path belongs to the host process, not to the requester.
    if (DEVICE_PATHS.test(written)) return;
    targets.push({ path: resolveWord(word, base, real) ?? written, access, word });
  };
  if (cwdInput) add(cwdInput, "unknown", root);

  const shell = SHELL_TOOLS.has(tool.toLowerCase()) || typeof input.command === "string" || Array.isArray(input.command);
  if (shell) {
    // An argv is one command: its words are literal. A literal shell body inside it is read by readShell, layer by layer.
    const source = Array.isArray(input.command) && input.command.every(word => typeof word === "string")
      ? (input.command as string[]).map(quoteWord).join(" ")
      : typeof input.command === "string" ? input.command : request.action;
    const reading = readShell(source, cwd, real, depth);
    for (const reason of reading.opaqueReasons) reasons.add(reason);
    commands.push(...reading.commands);
    const entered = new Set<string>();
    for (const command of commands) {
      // A directory the command runs in is a target of its own, so a command run elsewhere is judged there.
      if (command.cwd !== undefined && command.cwd !== cwd && !entered.has(command.cwd)) {
        entered.add(command.cwd);
        targets.push({ path: command.cwd, access: "unknown", word: command.cwd });
      }
      // In a directory the text does not establish, a relative path is unresolved.
      const base = command.cwdUnknown ? undefined : command.cwd ?? cwd;
      for (const redirect of command.redirects) add(redirect.target, redirect.op === "<" ? "read" : "write", base);
      for (const file of command.writes ?? []) add(file, "write", base);
      operandTargets(command, base, add, real);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" || !["file_path", "filePath", "path", "notebook_path", "notebookPath", "target", "destination", "source"].includes(key)) continue;
    const access: Access = WRITE_TOOL.test(tool) ? "write" : READ_TOOL.test(tool) ? "read" : "unknown";
    add(value, access, cwd);
  }
  if (Array.isArray(input.paths)) for (const value of input.paths) if (typeof value === "string") add(value, WRITE_TOOL.test(tool) ? "write" : "unknown", cwd);
  const patch = typeof input.patch === "string" ? input.patch : /apply_patch/i.test(tool) && typeof input.input === "string" ? input.input : undefined;
  if (patch) for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) add((match[1] ?? match[2]).trim(), "write", cwd);

  const urls: URL[] = [];
  const text = `${request.action}\n${safeJson(input)}`;
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s'"<>\\]+/gi)) {
    try { urls.push(new URL(match[0])); } catch { /* not a URL */ }
  }
  if (!request.shape.completeEvidence) reasons.add("incomplete-evidence");
  return { commands, targets, urls, opaque: reasons.size > 0, opaqueReasons: [...reasons], shell, tool, unresolved, ...(real ? { resolve: real } : {}) };
}

function operandTargets(command: SimpleCommand, cwd: string | undefined, add: (word: string, access: Access, base: string | undefined) => void, real?: PathResolver) {
  const { name, argv } = command;
  if (name === "cd" || name === "pushd") return;
  let base = cwd;
  if (name === "git") {
    for (let index = 1; index < argv.length; index++) {
      if (argv[index] === "-C" && argv[index + 1]) { add(argv[index + 1], "unknown", base); base = resolveWord(argv[index + 1], base, real) ?? base; index++; }
      else if (argv[index].startsWith("--git-dir=") || argv[index].startsWith("--work-tree=")) add(argv[index].slice(argv[index].indexOf("=") + 1), "unknown", base);
    }
  }
  const operands: string[] = [];
  let afterDoubleDash = false;
  for (let index = 1; index < argv.length; index++) {
    const word = argv[index];
    if (!afterDoubleDash && word === "--") { afterDoubleDash = true; continue; }
    if (!afterDoubleDash && word.startsWith("-")) {
      const equals = word.indexOf("=");
      if (equals > 0 && looksLikePath(word.slice(equals + 1))) add(word.slice(equals + 1), "unknown", base);
      continue;
    }
    operands.push(word);
  }
  // sed and awk take a program first; it is not a path.
  if ((name === "sed" || name === "awk" || name === "gawk") && !argv.some(arg => arg === "-e" || arg === "-f")) operands.shift();
  const inPlace = name === "sed" && argv.some(arg => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"));
  const every = PATH_COMMANDS.has(name);
  operands.forEach((word, index) => {
    // A path on another host is not a path here. The reading is opaque (`remote-target`).
    if (remoteOperand(name, word)) return;
    if (!every && !looksLikePath(word)) return;
    let access: Access = "unknown";
    if (READ_COMMANDS.has(name)) access = "read";
    if (WRITE_COMMANDS.has(name) || inPlace) access = "write";
    if (COPY_COMMANDS.has(name)) access = index === operands.length - 1 || name === "mv" ? "write" : "read";
    add(word, access, base);
  });
}

function looksLikePath(word: string): boolean {
  if (!word || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return false;
  return word.startsWith("/") || word.startsWith("~") || word.startsWith("$HOME") || word.startsWith("${HOME}")
    || word.startsWith("./") || word.startsWith("../") || word === "." || word === ".." || /^\.[^.\s]/.test(word) || word.includes("/");
}

const safeJson = (value: unknown) => { try { return JSON.stringify(value) ?? ""; } catch { return ""; } };

/** Whether `path` is the session root, a scratch root, or inside one. A `~` path is never inside. */
export function insideSession(request: PermissionRequest, path: string): boolean {
  if (path.startsWith("~")) return false;
  return [request.requester.sessionRoot, ...request.requester.scratchRoots].some(root => within(root, path));
}

function within(root: string, path: string): boolean {
  const base = posix.normalize(root).replace(/\/+$/, "") || "/";
  return path === base || path.startsWith(base === "/" ? "/" : `${base}/`);
}

/** Whether `path` contains `sequence` as consecutive segments (at its end for a file, or followed by more for a directory). */
function hasSegments(path: string, sequence: string): boolean {
  const segments = path.split("/").filter(Boolean);
  const wanted = sequence.split("/").filter(Boolean);
  for (let start = 0; start + wanted.length <= segments.length; start++)
    if (wanted.every((segment, offset) => segments[start + offset] === segment)) return true;
  return false;
}

/** The path relative to the session root or scratch root that holds it. */
function relativeToSession(request: PermissionRequest, path: string): string | undefined {
  for (const root of [request.requester.sessionRoot, ...request.requester.scratchRoots])
    if (within(root, path)) return posix.relative(posix.normalize(root), path);
  return undefined;
}

const optionWord = (word: string | undefined) => word !== undefined && word.length > 1 && word.startsWith("-");
/** An option that may take the next word as its value: one written without `=`. */
const mayTakeValue = (word: string | undefined) => optionWord(word) && !word!.includes("=");
const wordMatches = (have: string, want: string) => want.endsWith("*") ? have.startsWith(want.slice(0, -1)) : have === want;
const valuedOptions = (program: string): readonly string[] =>
  (PERMISSION_CLASS_LISTS.valuedGlobalOptions as Record<string, readonly string[] | undefined>)[program] ?? [];

/**
 * Whether `argv` runs `pattern`: the program by basename, then each further pattern word in order. An
 * option word between them does not hide a subcommand (`npm --silent login`), and neither does the value
 * of an option the program is known to take one for (`aws --profile p configure`). With `loose`, a word
 * right after any option written without `=` may also be its value (`npm --otp 123456 login`); a pattern
 * that matches only so is a raise, never a class. A pattern word ending in `*` matches a prefix.
 */
function runsPattern(argv: readonly string[], pattern: readonly string[], loose = false): boolean {
  if (!argv.length || !pattern.length || !wordMatches(posix.basename(argv[0]), pattern[0])) return false;
  const valued = valuedOptions(posix.basename(argv[0]));
  const from = (skipAnyValue: boolean) => {
    let index = 1;
    for (const want of pattern.slice(1)) {
      for (;; index++) {
        const word = argv[index];
        if (word === undefined) return false;
        if (wordMatches(word, want)) break;
        if (optionWord(word)) { if (!skipAnyValue && mayTakeValue(word) && valued.includes(word)) index++; continue; }
        if (skipAnyValue && mayTakeValue(argv[index - 1])) continue;
        return false;
      }
      index++;
    }
    return true;
  };
  return from(false) || (loose && from(true));
}

/** The command with the options between the program and its first subcommand removed, as commandWords skips them. */
function leadingOptionsRemoved(command: SimpleCommand, loose: boolean): string[] {
  const [head, ...rest] = command.argv;
  if (head === undefined) return [];
  const valued = valuedOptions(command.name);
  let index = 0;
  for (; index < rest.length && optionWord(rest[index]); index++)
    if (mayTakeValue(rest[index]) && (loose || valued.includes(rest[index]))) index++;
  return [head, ...rest.slice(index)];
}

/**
 * Whether the host's destructive detector matches the command: as written, or with the options between
 * its program and subcommand removed (`git -C dir clean -fdx`, `kubectl -n prod delete pod x`), whose
 * patterns are a program followed by its subcommand.
 */
function destructiveCommand(command: SimpleCommand, loose: boolean): boolean {
  return [command.words, leadingOptionsRemoved(command, false), ...(loose ? [leadingOptionsRemoved(command, true)] : [])]
    .some(words => words.length > 0 && matchDestructive(words.map(quoteWord).join(" ")) !== null);
}

/**
 * The command's words for subcommand matching: the program, then its words with options removed, and
 * with the value of an option the program is known to take one for (`git -C x config` reads as `git
 * config`). With `loose`, the word after any option written without `=` is removed too.
 */
function commandWords(command: SimpleCommand, loose = false): string[] {
  const [head, ...rest] = command.argv;
  if (head === undefined) return [];
  const valued = valuedOptions(command.name);
  const words = [head];
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index];
    if (!optionWord(word)) words.push(word);
    else if (mayTakeValue(word) && (loose || valued.includes(word))) index++;
  }
  return words;
}

const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/\.$/, "");
const hostListed = (host: string, list: readonly string[]) =>
  list.some(entry => entry.startsWith(".") ? host.endsWith(entry) || host === entry.slice(1) : host === entry);

function isGlobalSettingsCommand(command: SimpleCommand, request: PermissionRequest, real?: PathResolver, loose = false): boolean {
  return globalSettingsWords(command, commandWords(command), request, real)
    || (loose && globalSettingsWords(command, commandWords(command, true), request, real));
}

function globalSettingsWords(command: SimpleCommand, words: readonly string[], request: PermissionRequest, real?: PathResolver): boolean {
  const [name, sub, third] = [posix.basename(words[0] ?? ""), words[1], words[2]];
  const has = (...flags: string[]) => command.argv.some(arg => flags.some(flag => arg === flag || arg.startsWith(`${flag}=`)));
  if (name === "git" && sub === "config") {
    const read = has("--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--get-color", "--get-colorbool") || third === "get" || third === "list";
    if (read) return false;
    if (has("--global", "--system")) return true;
    if (has("--file", "-f")) {
      const index = command.argv.findIndex(arg => arg === "--file" || arg === "-f");
      const file = command.argv[index + 1];
      const path = file && resolveWord(file, command.cwdUnknown ? undefined : command.cwd ?? request.requester.sessionRoot, real);
      if (!path || !insideSession(request, path)) return true;
    }
    // A hook path or fsmonitor in the repository's own config runs code on later git commands.
    return command.argv.some(arg => /^(?:core\.hookspath|core\.fsmonitor|core\.sshcommand|core\.pager|include\.path|includeif\.)/i.test(arg));
  }
  if (["npm", "pnpm", "yarn"].includes(name) && sub === "config" && ["set", "delete", "edit", "rm"].includes(third ?? ""))
    return !command.argv.some((arg, index) => (arg === "--location" && command.argv[index + 1] === "project") || arg === "--location=project");
  if (name === "gh" && ((sub === "config" && third === "set") || (sub === "extension" && ["install", "upgrade", "remove"].includes(third ?? "")) || (sub === "alias" && third === "set"))) return true;
  if (name === "defaults" && ["write", "delete", "import", "rename"].includes(sub ?? "")) return true;
  if (name === "claude" && (sub === "mcp" || sub === "plugin" || sub === "plugins" || (sub === "config" && ["set", "add", "remove"].includes(third ?? "")))) return !["list", "get"].includes(third ?? "");
  if (name === "codex" && (sub === "mcp" || sub === "plugin" || (sub === "features" && ["enable", "disable"].includes(third ?? "")))) return !["list", "get"].includes(third ?? "");
  if (name === "opencode" && ["mcp", "plugin", "plug", "agent"].includes(sub ?? "")) return !["list", "ls"].includes(third ?? "");
  if (name === "launchctl" && ["load", "unload", "bootstrap", "bootout", "enable", "disable", "setenv", "submit"].includes(sub ?? "")) return true;
  if (name === "systemctl" && command.argv.slice(1).some(arg => ["enable", "disable", "mask", "unmask", "edit", "set-property", "link", "set-environment"].includes(arg))) return true;
  if (name === "crontab") return !has("-l");
  if (["chsh", "scutil", "networksetup", "update-alternatives", "visudo", "usermod", "useradd", "passwd"].includes(name)) return true;
  if (name === "sysctl" && has("-w")) return true;
  return false;
}

/**
 * One class rule. `loose` is set only by the raise rules: a rule that matches a program and its
 * subcommand words (`command: true`) then also accepts a word after an unknown option as its value.
 */
type ClassRule = {
  name: string; interruptClass: InterruptClass; command?: true;
  test: (request: PermissionRequest, reading: RequestReading, facts: HostRuleFacts, loose: boolean) => boolean;
};

const CLASS_RULES: readonly ClassRule[] = [
  { name: "class:trust-prompt", interruptClass: "global-or-account-settings", test: request => request.shape.trustPrompt },
  { name: "class:persistent-only", interruptClass: "global-or-account-settings", test: request => request.shape.persistentOnly },
  {
    name: "class:delivery-command", interruptClass: "production-or-staging", command: true,
    test: (request, reading, _facts, loose) => {
      const configured = (request.deliveryCommands ?? []).map(command => readShell(command).commands[0]?.argv).filter((argv): argv is string[] => Boolean(argv?.length));
      return reading.commands.some(command => configured.some(pattern => runsPattern(command.argv, pattern, loose)));
    },
  },
  {
    name: "class:host-release", interruptClass: "production-or-staging", command: true,
    test: (_request, reading, facts, loose) => reading.commands.some(command =>
      [...PERMISSION_CLASS_LISTS.hostReleaseCommands, ...(facts.releaseCommands ?? [])].some(pattern => runsPattern(command.argv, pattern, loose))),
  },
  {
    name: "class:credential-command", interruptClass: "credentials", command: true,
    test: (_request, reading, _facts, loose) => reading.commands.some(command => PERMISSION_CLASS_LISTS.credentialCommands.some(pattern => runsPattern(command.argv, pattern, loose))),
  },
  {
    name: "class:credential-store", interruptClass: "credentials",
    test: (request, reading) => reading.targets.some(target => !insideSession(request, target.path)
      && PERMISSION_CLASS_LISTS.credentialPaths.some(sequence => hasSegments(target.path, sequence))),
  },
  {
    name: "class:payment-tool", interruptClass: "money",
    test: request => {
      const tool = request.tool.toLowerCase();
      const server = tool.startsWith("mcp__") ? tool.slice(5).split("__")[0] : tool.includes("_") ? tool.split("_")[0] : undefined;
      return server !== undefined && (PERMISSION_CLASS_LISTS.paymentToolServers as readonly string[]).includes(server);
    },
  },
  {
    name: "class:payment-command", interruptClass: "money", command: true,
    test: (_request, reading, _facts, loose) => reading.commands.some(command => PERMISSION_CLASS_LISTS.paymentCommands.some(pattern => runsPattern(command.argv, pattern, loose))),
  },
  {
    name: "class:payment-endpoint", interruptClass: "money",
    test: (_request, reading) => reading.urls.some(url => hostListed(hostOf(url), PERMISSION_CLASS_LISTS.paymentHosts)),
  },
  {
    name: "class:destructive-outside", interruptClass: "destructive-outside-workspace", command: true,
    test: (request, reading, _facts, loose) => {
      const destructive = reading.commands.filter(command => destructiveCommand(command, loose));
      if (!request.destructive && !destructive.length) return false;
      const scope = destructive.length ? destructive : reading.commands;
      const paths: string[] = [];
      for (const command of scope) {
        const base = command.cwdUnknown ? undefined : command.cwd ?? request.requester.sessionRoot;
        for (const target of reading.targets) if (command.words.includes(target.word) || command.redirects.some(redirect => redirect.target === target.word)) paths.push(target.path);
        // A git command with no path operand acts on its working directory. An unknown one is not established: the reading is opaque.
        const gitDirectory = command.name !== "git" ? undefined
          : command.argv.includes("-C") ? resolveWord(command.argv[command.argv.indexOf("-C") + 1] ?? "", base, reading.resolve) ?? base : base;
        if (gitDirectory !== undefined) paths.push(gitDirectory);
      }
      return paths.some(path => !insideSession(request, path));
    },
  },
  {
    name: "class:host-configuration", interruptClass: "global-or-account-settings",
    test: (request, reading, facts) => reading.targets.some(target => target.access === "write" && !insideSession(request, target.path)
      && [...PERMISSION_CLASS_LISTS.hostProtectedPaths, ...(facts.protectedPaths ?? [])].some(root => within(root, target.path))),
  },
  {
    name: "class:settings-outside-root", interruptClass: "global-or-account-settings",
    test: (request, reading) => reading.targets.some(target => target.access === "write" && !insideSession(request, target.path)
      && PERMISSION_CLASS_LISTS.settingsPaths.some(sequence => hasSegments(target.path, sequence))),
  },
  {
    name: "class:provider-settings-in-root", interruptClass: "global-or-account-settings",
    test: (request, reading) => reading.targets.some(target => {
      if (target.access !== "write") return false;
      const relative = relativeToSession(request, target.path);
      return relative !== undefined && PERMISSION_CLASS_LISTS.providerSettingsInRoot.some(sequence => hasSegments(relative, sequence));
    }),
  },
  {
    name: "class:global-settings-command", interruptClass: "global-or-account-settings", command: true,
    test: (request, reading, _facts, loose) => reading.commands.some(command => isGlobalSettingsCommand(command, request, reading.resolve, loose)),
  },
];

/** The first class rule that matches, among the classes in force. It never allows anything. */
export function classify(request: PermissionRequest, interruptClasses: readonly string[], facts: HostRuleFacts = {}, reading = readRequest(request)): PermissionClassMatch | undefined {
  for (const rule of CLASS_RULES) {
    if (!interruptClasses.includes(rule.interruptClass)) continue;
    if (rule.test(request, reading, facts, false)) return { interruptClass: rule.interruptClass, rule: rule.name };
  }
  return undefined;
}

const RELEASE_WORD = /(?:^|[^a-z])(?:publish|deploy|deployment|release|promote|rollout|roll-out|ship)(?:[^a-z]|$)/i;
const CREDENTIAL_WORD = /token|secret|passw(?:or)?d|credential|api[_-]?key|private[_-]?key|\bauth\b|oauth|\.pem\b|\.key\b|\.p12\b|\.pfx\b|id_rsa|id_ed25519|id_ecdsa|keychain|\.netrc|(?:^|[^a-z])\.env\b|ssh-agent|\bgpg\b|\bkms\b/i;
// "checkout" is left out: `git checkout` is routine, and payment checkouts are caught by the provider name and endpoint lists.
const PAYMENT_WORD = /payment|billing|invoice|purchase|refund|subscription|payout|\bcharges?\b|stripe|paypal|credit[_-]?card|\bwallet\b/i;
/** The first subcommand word, with options before it removed (`npm --silent install -g x`). */
const subcommand = (command: SimpleCommand) => commandWords(command)[1] ?? "";
const GLOBAL_INSTALL: ReadonlyArray<(command: SimpleCommand) => boolean> = [
  command => ["npm", "pnpm", "bun"].includes(command.name) && ["install", "i", "add", "link"].includes(subcommand(command)) && command.argv.some(arg => arg === "-g" || arg === "--global" || arg === "--location=global"),
  command => command.name === "yarn" && subcommand(command) === "global",
  command => ["brew", "port", "apt", "apt-get", "dnf", "yum", "pacman", "apk", "snap", "pipx", "gem"].includes(command.name) && ["install", "upgrade", "reinstall", "add", "tap"].includes(subcommand(command)),
  command => ["cargo", "go"].includes(command.name) && subcommand(command) === "install",
  command => command.name === "uv" && subcommand(command) === "tool",
  command => /^pip\d*(?:\.\d+)?$/.test(command.name) && subcommand(command) === "install" && command.argv.some(arg => arg === "--user" || arg === "--break-system-packages"),
];

/**
 * Bounds of the embedded-command search for one request. A command with more than `words` words is not
 * searched, a candidate longer than `length` characters is not read, at most `readings` candidates are
 * read, and commands found inside candidates are searched to `layers` levels. A request the search did
 * not cover is raised as opaque.
 */
export const EMBEDDED_COMMAND_LIMITS = { words: 64, length: 4_000, readings: 256, layers: 2 } as const;
/** Commands that never run an argument. Their arguments are not searched. */
const NEVER_RUN = new Set(["echo", "printf", "grep", "egrep", "fgrep", "cat", "head", "tail", "wc"]);
/** Opaque reasons that mean a candidate runs code the host does not read. */
const RUNS_UNREAD_CODE = new Set(["inline-code", "inline-shell", "code-from-input", "code-environment"]);

/**
 * Whether a command hides one that a class rule matches: a tail of its words, which a wrapper the shell
 * reader does not know would run (`setsid npm login`), or one of its words read as a shell body (`watch
 * 'npm login'`, `ssh host 'npm login'`). Each candidate is read as its own command line in the command's
 * directory, and every class rule is tried on it. A match is a guess, so it only raises; it never sends a
 * request to the owner. "unread" when the search did not cover the request: it reached a bound, or a
 * candidate runs code the host does not read (`npx tsx -e …`, `uv run python -c …`).
 */
function embeddedCommand(request: PermissionRequest, reading: RequestReading, facts: HostRuleFacts): "found" | "unread" | undefined {
  const limits = EMBEDDED_COMMAND_LIMITS;
  const { destructive: _destructive, ...plain } = request;
  // Candidates share most of their paths: each is resolved once.
  const known = new Map<string, string | undefined>();
  const resolve: PathResolver | undefined = reading.resolve && (path => {
    if (!known.has(path)) known.set(path, reading.resolve!(path));
    return known.get(path);
  });
  const seen = new Set<string>();
  let readings = 0;
  let unread = false;
  const queue = reading.commands.map(command => ({ command, layer: 0 }));
  for (let item = queue.shift(); item; item = queue.shift()) {
    const { command, layer } = item;
    // A command in a directory the text does not establish is already opaque.
    if (command.cwdUnknown || NEVER_RUN.has(command.name) || command.argv.length < 2) continue;
    if (command.argv.length > limits.words) { unread = true; continue; }
    const candidates: Array<{ source: string; depth: number }> = [];
    command.argv.forEach((word, index) => {
      if (index === 0) return;
      // A tail that starts with an option names no command.
      if (!word.startsWith("-")) candidates.push({ source: command.argv.slice(index).map(quoteWord).join(" "), depth: command.depth });
      if (/\s/.test(word) && command.depth < MAX_SHELL_DEPTH) candidates.push({ source: word, depth: command.depth + 1 });
    });
    for (const { source, depth } of candidates) {
      const key = `${command.cwd ?? ""}\n${depth}\n${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (source.length > limits.length) { unread = true; continue; }
      if (++readings > limits.readings) return "unread";
      const pattern = matchDestructive(source);
      const candidate: PermissionRequest = {
        ...plain, tool: "Bash", action: source,
        input: { command: source, ...(command.cwd !== undefined ? { workdir: command.cwd } : {}) },
        shape: { ...request.shape, trustPrompt: false, persistentOnly: false },
        ...(pattern ? { destructive: { pattern } } : {}),
      };
      const candidateReading = readRequest(candidate, resolve, depth);
      if (CLASS_RULES.some(rule => rule.test(candidate, candidateReading, facts, false))) return "found";
      if (candidateReading.opaqueReasons.some(reason => RUNS_UNREAD_CODE.has(reason))) unread = true;
      if (layer + 1 < limits.layers) for (const inner of candidateReading.commands) queue.push({ command: inner, layer: layer + 1 });
    }
  }
  return unread ? "unread" : undefined;
}

/**
 * The raise rules that match. They only select the strong tier for a fresh turn. `facts` are the host
 * facts the class rules use, for the embedded-command rule.
 */
export function raise(request: PermissionRequest, context: { rejectHistory: boolean }, reading = readRequest(request), facts: HostRuleFacts = {}): string[] {
  const raised: string[] = [];
  const words = reading.commands.flatMap(command => command.words);
  const text = `${request.tool}\n${request.action}\n${safeJson(request.input ?? {})}`;
  // A raise may read loosely: an unknown option's value does not hide `git --x v reset --hard`.
  if (request.destructive || reading.commands.some(command => destructiveCommand(command, true))) raised.push("raise:destructive");
  if (reading.targets.some(target => !insideSession(request, target.path))) raised.push("raise:outside-root");
  if (words.some(word => RELEASE_WORD.test(word)) || reading.commands.some(command => commandWords(command).slice(1, 3).includes("push")) || RELEASE_WORD.test(request.tool))
    raised.push("raise:release-verb");
  if (reading.commands.some(command => command.privileged || ["setcap", "chroot", "nsenter", "unshare", "capsh"].includes(command.name)
    || (command.name === "chmod" && command.argv.some(arg => /^(?:[ugoa]*\+[rwxXt]*s|[2-7][0-7]{3})$/.test(arg)))
    || (["chown", "chgrp"].includes(command.name) && command.argv.some(arg => /^root(?::|$)|^0(?::|$)/.test(arg)))))
    raised.push("raise:privilege");
  if (CREDENTIAL_WORD.test(text)) raised.push("raise:credential-name");
  if (PAYMENT_WORD.test(text)) raised.push("raise:payment-name");
  if (reading.targets.some(target => {
    const relative = relativeToSession(request, target.path);
    if (relative === undefined) return false;
    const base = posix.basename(relative);
    return [...PERMISSION_CLASS_LISTS.providerSettingsInRoot, ...PERMISSION_CLASS_LISTS.settingsInRoot].some(sequence => hasSegments(relative, sequence))
      || /^\.[\w.-]*rc(?:\.[\w-]+)?$/.test(base) || /^\.env(?:\..+)?$/.test(base);
  })) raised.push("raise:settings-in-root");
  if (reading.commands.some(command => GLOBAL_INSTALL.some(test => test(command)))) raised.push("raise:global-install");
  // A subcommand that a class rule names, behind an option the host does not know to take a value, may be that subcommand.
  if (CLASS_RULES.some(rule => rule.command && !rule.test(request, reading, facts, false) && rule.test(request, reading, facts, true)))
    raised.push("raise:option-subcommand");
  const embedded = reading.shell ? embeddedCommand(request, reading, facts) : undefined;
  if (embedded === "found") raised.push("raise:embedded-command");
  if (reading.opaque || embedded === "unread" || reading.unresolved.length > 0 || (!reading.shell && !KNOWN_TOOLS.test(request.tool))) raised.push("raise:opaque");
  // A screen dialog shows its command wrapped to the terminal's width, and the screen does not say which line
  // breaks are the command's own. Any reading of such a command is a guess, so the light tier never decides it.
  if (request.tool === "dialog" && request.input === undefined && request.action.includes("\n")) raised.push("raise:wrapped-dialog");
  if (context.rejectHistory) raised.push("raise:reject-history");
  return raised;
}

/** Tools whose effect the host reads from their input. Any other tool is raised as opaque. */
const KNOWN_TOOLS = /^(?:read|write|edit|multiedit|notebookedit|notebookread|glob|grep|ls|list|apply_patch|webfetch|websearch|todowrite|todoread)$/i;
