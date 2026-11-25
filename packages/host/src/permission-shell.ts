import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { posix } from "node:path";

export interface SimpleCommand {
  argv: string[];
  name: string;
  words: string[];
  redirects: Array<{ op: string; target: string }>;
  privileged: boolean;
  cwd?: string;
  cwdUnknown?: boolean;
  depth: number;
  writes?: string[];
}

export interface ShellReading {
  commands: SimpleCommand[];
  opaque: boolean;
  opaqueReasons: string[];
}

type Token = { kind: "word"; text: string; expands: boolean } | { kind: "op"; text: string };

export const MAX_SHELL_DEPTH = 3;

const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", "\n", "(", ")"]);
const REDIRECTS = new Set([">", ">>", "<", ">|", "&>", "&>>", "<>", ">&", "<&", "<<<"]);
const PRIVILEGE = new Set(["sudo", "doas", "su", "pkexec", "run0"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);
interface Interpreter {
  code: string; valued?: string; attached?: string; digits?: string; stop?: string;
  long?: readonly string[]; longValued?: readonly string[]; words?: readonly string[]; modes?: readonly string[]; fromInput?: boolean;
  codeValue?: (option: string, value: string) => boolean;
}
const INTERPRETERS: Record<string, Interpreter> = {
  python: { code: "c", valued: "mWXQ", stop: "m", longValued: ["--check-hash-based-pycs"], modes: ["-m", "-V", "--version", "-h", "--help"], fromInput: true },
  node: {
    code: "ep", valued: "rC", long: ["--eval", "--print"], fromInput: true,
    longValued: ["--require", "--import", "--loader", "--experimental-loader", "--conditions", "--input-type", "--env-file", "--title"],
    codeValue: (option, value) => ["-r", "--require", "--import", "--loader", "--experimental-loader"].includes(option) && /^data:/i.test(value),
    modes: ["--test", "--run", "-v", "--version", "-h", "--help", "-c", "--check"],
  },
  deno: { code: "", long: ["--eval"], words: ["eval"] },
  bun: { code: "e", long: ["--eval", "--print"] },
  perl: {
    code: "eE", valued: "M", attached: "iImFxdDCV", digits: "l0", modes: ["-v", "-V", "-h"], fromInput: true,
    codeValue: (option, value) => option === "-M" && !/^-?[A-Za-z_]\w*(?:::\w+)*(?:=[^;]*)?$/.test(value.replace(/^=/, "")),
  },
  ruby: { code: "e", valued: "IrCE", attached: "FixKTW", digits: "0", modes: ["-v", "--version", "-h", "--help"], fromInput: true },
  php: { code: "rRBE", valued: "dcfztSF", modes: ["-v", "-h", "-m", "-i", "-S", "-l"], fromInput: true },
  lua: { code: "e", valued: "l", modes: ["-v"], fromInput: true },
  osascript: { code: "e", valued: "ls", fromInput: true },
  Rscript: { code: "e", modes: ["--version"] },
  R: { code: "e", valued: "fd" },
  julia: { code: "eE", valued: "tpCJL", attached: "Og", long: ["--eval", "--print"] },
  elixir: { code: "e", valued: "r", long: ["--eval"] },
  expect: { code: "c", valued: "fbD" },
};

const INERT_NODE_OPTIONS = [
  /^--(?:max-old-space-size|max-semi-space-size|stack-trace-limit)=\d+$/,
  /^--(?:enable-source-maps|no-warnings|trace-warnings|no-deprecation|trace-deprecation|experimental-vm-modules|expose-gc)$/,
  /^--unhandled-rejections=(?:throw|strict|warn|warn-with-error-code|none)$/,
  /^--dns-result-order=(?:verbatim|ipv4first|ipv6first)$/,
];
const ENVIRONMENT_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)(.*)$/s;

const CODE_ENVIRONMENT_ASSIGNMENTS: ReadonlyArray<{ names: readonly string[]; raises: (value: string) => boolean }> = [
  {
    names: ["NODE_OPTIONS"],
    raises: value => value.split(/\s+/).filter(Boolean).some(option => !INERT_NODE_OPTIONS.some(pattern => pattern.test(option))),
  },
  {
    names: ["LD_PRELOAD", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "PROMPT_COMMAND",
      "PERL5OPT", "RUBYOPT", "PYTHONSTARTUP"],
    raises: () => true,
  },
  {
    names: ["GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_EXEC_PATH", "GIT_PROXY_COMMAND"],
    raises: () => true,
  },
  {
    names: ["GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "EDITOR", "VISUAL", "PAGER"],
    raises: value => !["", "cat", "true", ":", "/dev/null"].includes(value),
  },
  {
    names: ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_*", "GIT_CONFIG_VALUE_*"],
    raises: () => true,
  },
  {
    names: ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"],
    raises: value => value !== "/dev/null",
  },
  {
    names: [
      "NODE_PATH",
      "PYTHONPATH",
      "PERL5LIB",
      "RUBYLIB",
      "LD_LIBRARY_PATH",
      "GIT_DIR",
    ],
    raises: value => value.split(":").some(entry => entry.startsWith("/") || entry.startsWith("~")
      || entry.split("/").includes("..") || entry.includes("$")),
  },
];

function isCodeEnvironmentAssignment(word: string): boolean {
  const assignment = ENVIRONMENT_ASSIGNMENT.exec(word);
  if (!assignment) return false;
  const [, name, operator, value] = assignment;
  return CODE_ENVIRONMENT_ASSIGNMENTS.some(rule => rule.names.some(pattern => {
    if (!pattern.endsWith("*")) return name === pattern;
    const prefix = pattern.slice(0, -1);
    return name.startsWith(prefix) && name.length > prefix.length;
  }) && (operator === "+=" || rule.raises(value)));
}

const STDIN_PATHS = new Set(["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);
function interpreterOf(name: string): string | undefined {
  if (/^(?:python|pypy)[\d.]*$/.test(name)) return "python";
  if (["nodejs", "tsx", "ts-node", "ts-node-esm"].includes(name)) return "node";
  if (/^lua(?:jit|[\d.]+)?$/.test(name)) return "lua";
  const versioned = /^(perl|php|ruby)[\d.]*$/.exec(name);
  if (versioned) return versioned[1];
  return Object.hasOwn(INTERPRETERS, name) ? name : undefined;
}

function interpreterWords(spec: Interpreter, argv: readonly string[]): { code: boolean; script: boolean; dash: boolean; mode: boolean } {
  const found = { code: false, script: false, dash: false, mode: false };
  for (let index = 1; index < argv.length; index++) {
    const word = argv[index];
    if (spec.words?.includes(word)) { found.code = true; break; }
    if (word === "-" || STDIN_PATHS.has(word)) { found.dash = true; continue; }
    if (word === "--") { found.script ||= index + 1 < argv.length; break; }
    if (!word.startsWith("-")) { found.script = true; continue; }
    if (spec.modes?.includes(word)) found.mode = true;
    if (word.startsWith("--")) {
      const option = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
      if (spec.long?.includes(option)) { found.code = true; break; }
      if (spec.longValued?.includes(option)) {
        const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : argv[index + 1];
        if (value !== undefined && spec.codeValue?.(option, value)) { found.code = true; break; }
        if (!word.includes("=")) index++;
      }
      continue;
    }
    let stop = false;
    for (let at = 1; at < word.length; at++) {
      const letter = word[at];
      if (spec.code.includes(letter)) { found.code = true; break; }
      if (spec.digits?.includes(letter)) {
        if (letter === "0" && word[at + 1] === "x") for (at++; /[0-9a-fA-F]/.test(word[at + 1] ?? ""); at++);
        else for (; /[0-7]/.test(word[at + 1] ?? ""); at++);
        continue;
      }
      if (spec.attached?.includes(letter)) break;
      if (spec.valued?.includes(letter)) {
        const option = `-${letter}`;
        const value = at + 1 === word.length ? argv[index + 1] : word.slice(at + 1).replace(/^=/, "");
        if (value !== undefined && spec.codeValue?.(option, value)) { found.code = true; break; }
        if (at + 1 === word.length) index++;
        stop = Boolean(spec.stop?.includes(letter));
        break;
      }
    }
    if (found.code || stop) break;
  }
  return found;
}

function shellCommandString(argv: readonly string[]): { command: boolean; index: number; literal: boolean } {
  let command = false;
  let index = 1;
  for (; index < argv.length; index++) {
    const word = argv[index];
    if (word === "--" || word === "-") { index++; break; }
    if (word.startsWith("--")) {
      if (word.startsWith("--command=")) return { command: true, index, literal: false };
      if (word === "--command") command = true;
      else if (["--rcfile", "--init-file", "--init-command"].includes(word)) index++;
      continue;
    }
    if (!/^[-+][A-Za-z]+$/.test(word)) break;
    if (word[0] === "-" && word.includes("c")) command = true;
    index += (word.match(/[oO]/g) ?? []).length;
  }
  return { command, index, literal: true };
}
interface Wrapper {
  valued: ReadonlySet<string>;
  environment?: ReadonlySet<string>;
  chdir?: ReadonlySet<string>;
  root?: ReadonlySet<string>;
  split?: ReadonlySet<string>;
  shell?: ReadonlySet<string>;
  alwaysShell?: boolean;
  operands?: number;
  operandWrites?: boolean;
  writes?: ReadonlySet<string>;
  body?: ReadonlySet<string>;
  bodyOnly?: boolean;
  joined?: boolean;
  exec?: ReadonlySet<string>;
  noCommand?: ReadonlySet<string>;
  attach?: ReadonlySet<string>;
}
const options = (...names: string[]): ReadonlySet<string> => new Set(names);
const WRAPPERS: Record<string, Wrapper> = {
  sudo: {
    valued: options("-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "-R", "--user", "--group", "--close-from", "--chdir", "--host",
      "--prompt", "--role", "--type", "--command-timeout", "--other-user", "--chroot"),
    chdir: options("-D", "--chdir"), root: options("-R", "--chroot"), shell: options("-i", "-s", "--login", "--shell"),
  },
  doas: { valued: options("-u", "-C"), shell: options("-s") },
  pkexec: { valued: options("--user"), alwaysShell: true },
  run0: { valued: options("-u", "--user", "-g", "--group", "-D", "--chdir", "--setenv", "--property", "--slice", "--unit", "--description", "--nice", "--machine"),
    chdir: options("-D", "--chdir"), environment: options("--setenv"), alwaysShell: true },
  env: { valued: options("-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"), chdir: options("-C", "--chdir"), split: options("-S", "--split-string") },
  nohup: { valued: options() }, builtin: { valued: options() }, exec: { valued: options("-a") },
  command: { valued: options(), noCommand: options("-v", "-V") },
  time: { valued: options("-f", "--format", "-o", "--output"), writes: options("-o", "--output") },
  nice: { valued: options("-n", "--adjustment") }, stdbuf: { valued: options("-i", "-o", "-e") },
  ionice: { valued: options("-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"), noCommand: options("-p", "--pid", "-P", "--pgid", "-u", "--uid") },
  caffeinate: { valued: options("-t", "-w") }, chronic: { valued: options() }, unbuffer: { valued: options() },
  timeout: { valued: options("-s", "--signal", "-k", "--kill-after"), operands: 1 },
  setsid: { valued: options() }, busybox: { valued: options(), noCommand: options("--install", "--list", "--list-full", "--show", "--help") },
  flock: { valued: options("-w", "--timeout", "--wait", "-E", "--conflict-exit-code"), operands: 1, operandWrites: true, body: options("-c", "--command") },
  strace: {
    valued: options("-a", "-b", "-e", "-E", "-I", "-o", "-O", "-p", "-P", "-s", "-S", "-u", "-U", "-X", "--output", "--attach", "--user", "--env",
      "--trace", "--trace-path", "--signal", "--status", "--string-limit", "--summary-sort-by", "--columns"),
    environment: options("-E", "--env"), writes: options("-o", "--output"), noCommand: options("-p", "--attach"), attach: options("-p", "--attach"),
  },
  ltrace: {
    valued: options("-a", "-A", "-D", "-e", "-F", "-l", "-n", "-o", "-p", "-s", "-u", "-w", "-x", "--output", "--library"),
    writes: options("-o", "--output"), noCommand: options("-p"), attach: options("-p"),
  },
  taskset: { valued: options(), operands: 1, noCommand: options("-p", "--pid") },
  chrt: { valued: options("-T", "--sched-runtime", "-P", "--sched-period", "-D", "--sched-deadline"), operands: 1, noCommand: options("-p", "--pid", "-m", "--max") },
  script: {
    valued: options("-c", "--command", "-E", "--echo", "-I", "--log-in", "-O", "--log-out", "-B", "--log-io", "-T", "--log-timing", "-m", "--logging-format", "-o", "--output-limit"),
    body: options("-c", "--command"), bodyOnly: true, writes: options("-I", "--log-in", "-O", "--log-out", "-B", "--log-io", "-T", "--log-timing"),
  },
  watch: { valued: options("-n", "--interval", "-q", "--equexit"), joined: true, exec: options("-x", "--exec") },
};

type Directory = { path?: string; unknown: boolean };

export function readShell(source: string, cwd?: string, real?: PathResolver, depth = 0): ShellReading {
  const reasons = new Set<string>();
  const commands = readLine(source, { path: cwd, unknown: false }, real, depth, reasons);
  return { commands, opaque: reasons.size > 0, opaqueReasons: [...reasons] };
}

function readLine(source: string, start: Directory, real: PathResolver | undefined, depth: number, reasons: Set<string>): SimpleCommand[] {
  const tokens = lex(source, reasons);
  const commands: SimpleCommand[] = [];
  let current: Token[] = [];
  let directory = start;
  let piped = false;
  const flush = () => {
    if (!current.length) return;
    const built = build(current, reasons, directory, real, piped);
    current = [];
    if (!built) return;
    const { body, ...rest } = built;
    const command: SimpleCommand = { ...rest, depth };
    if (body !== undefined) {
      if (depth >= MAX_SHELL_DEPTH) { reasons.add("shell-depth"); commands.push(command); return; }
      const inner = readLine(body, { path: command.cwd, unknown: Boolean(command.cwdUnknown) }, real, depth + 1, reasons);
      for (const nested of inner) commands.push(command.privileged ? { ...nested, privileged: true } : nested);
      if (command.redirects.length || command.writes?.length) commands.push({ ...command, argv: [], name: "", words: [] });
      return;
    }
    if (command.name === "cd" || command.name === "pushd" || command.name === "popd") directory = changeDirectory(command, directory, real, reasons);
    commands.push(command);
  };
  for (const token of tokens) {
    if (token.kind === "op" && SEPARATORS.has(token.text)) { flush(); piped = token.text === "|" || token.text === "|&"; }
    else current.push(token);
  }
  flush();
  return commands;
}

function changeDirectory(command: SimpleCommand, directory: Directory, real: PathResolver | undefined, reasons: Set<string>): Directory {
  const operands = command.argv.slice(1).filter(arg => arg !== "-L" && arg !== "-P" && arg !== "--");
  if (command.name === "cd" && operands.length === 0) return { path: "~", unknown: false };
  const target = operands.length === 1 && !/^[-+]/.test(operands[0]) && command.name !== "popd" ? operands[0] : undefined;
  const path = target === undefined || directory.unknown ? undefined : resolveWord(target, directory.path, real);
  if (path !== undefined) return { path, unknown: false };
  reasons.add("unresolved-directory");
  return { unknown: true };
}

function wrapperOptions(words: ReadonlyArray<{ text: string; expands: boolean }>, start: number, wrapper: Wrapper, env: boolean) {
  const found: Array<{ option: string; value?: { text: string; expands: boolean } }> = [];
  const assignments: string[] = [];
  let index = start;
  while (words[index]) {
    const text = words[index].text;
    if (text === "--") {
      index++;
      if (env) while (ENVIRONMENT_ASSIGNMENT.test(words[index]?.text ?? "")) assignments.push(words[index++].text);
      break;
    }
    if (env && ENVIRONMENT_ASSIGNMENT.test(text)) { assignments.push(text); index++; continue; }
    if (env && text === "-") { index++; continue; }
    if (!text.startsWith("-") || text === "-") break;
    index++;
    if (text.startsWith("--")) {
      const equals = text.indexOf("=");
      const option = equals < 0 ? text : text.slice(0, equals);
      if (equals >= 0) found.push({ option, value: { text: text.slice(equals + 1), expands: words[index - 1].expands } });
      else if (wrapper.valued.has(option)) found.push({ option, value: words[index++] });
      else found.push({ option });
      continue;
    }
    for (let letter = 1; letter < text.length; letter++) {
      const option = `-${text[letter]}`;
      if (!wrapper.valued.has(option)) { found.push({ option }); continue; }
      const rest = text.slice(letter + 1);
      found.push({ option, value: rest ? { text: rest, expands: words[index - 1].expands } : words[index++] });
      break;
    }
  }
  return { next: index, found, assignments };
}

function lex(source: string, reasons: Set<string>): Token[] {
  const tokens: Token[] = [];
  let word = "", inWord = false, expands = false;
  const end = () => {
    if (inWord) tokens.push({ kind: "word", text: word, expands });
    word = ""; inWord = false; expands = false;
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index], next = source[index + 1];
    if (char === "\\") {
      if (next === "\n") { index++; continue; }
      if (next !== undefined) { word += next; inWord = true; index++; }
      continue;
    }
    if (char === "'") {
      const close = source.indexOf("'", index + 1);
      const stop = close < 0 ? source.length : close;
      word += source.slice(index + 1, stop); inWord = true; index = stop;
      continue;
    }
    if (char === "\"") {
      inWord = true;
      for (index++; index < source.length && source[index] !== "\""; index++) {
        const inner = source[index];
        if (inner === "\\" && "\"\\$`\n".includes(source[index + 1] ?? "")) { word += source[++index]; continue; }
        if (inner === "`" || (inner === "$" && source[index + 1] === "(")) reasons.add("command-substitution");
        if (inner === "$") expands = true;
        word += inner;
      }
      continue;
    }
    if (char === "`") { reasons.add("command-substitution"); word += char; inWord = true; continue; }
    if (char === "$") {
      if (next === "(") reasons.add(source[index + 2] === "(" ? "arithmetic" : "command-substitution");
      expands = true; word += char; inWord = true;
      continue;
    }
    if (char === "#" && !inWord) {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline - 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") { end(); continue; }
    if (char === "\n") { end(); tokens.push({ kind: "op", text: "\n" }); continue; }
    if ((char === "<" || char === ">") && next === "(") { reasons.add("process-substitution"); end(); index++; continue; }
    const op = operatorAt(source, index);
    if (op) {
      if ((op.startsWith(">") || op.startsWith("<")) && inWord && /^\d+$/.test(word) && !expands) { word = ""; inWord = false; }
      end();
      if (op === "<<" || op === "<<-") reasons.add("here-document");
      tokens.push({ kind: "op", text: op });
      index += op.length - 1;
      continue;
    }
    word += char; inWord = true;
  }
  end();
  return tokens;
}

function operatorAt(source: string, index: number): string | undefined {
  for (const op of ["&>>", "<<<", "<<-", "&&", "||", "|&", ">>", ">|", "&>", "<>", ">&", "<&", "<<", ";", "|", "&", ">", "<", "(", ")"])
    if (source.startsWith(op, index)) return op;
  return undefined;
}

type Built = Omit<SimpleCommand, "depth"> & { body?: string };

function build(tokens: Token[], reasons: Set<string>, directory: Directory, real: PathResolver | undefined, piped: boolean): Built | undefined {
  const words: Array<{ text: string; expands: boolean }> = [];
  const redirects: SimpleCommand["redirects"] = [];
  let hereString = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "op") {
      if (token.text === "<<<") hereString = true;
      if (REDIRECTS.has(token.text) || token.text === "<<" || token.text === "<<-") {
        const target = tokens[index + 1];
        if (target?.kind === "word") {
          index++;
          if (target.expands) reasons.add("variable-target");
          if (token.text !== "<<<" && token.text !== "<<" && token.text !== "<<-" && !/^(?:\d+|-)$/.test(target.text))
            redirects.push({ op: token.text, target: target.text });
        }
      }
      continue;
    }
    words.push(token);
  }
  let start = 0;
  let codeEnvironment = false;
  while (start < words.length && ENVIRONMENT_ASSIGNMENT.test(words[start].text)) {
    codeEnvironment ||= isCodeEnvironmentAssignment(words[start].text);
    start++;
  }
  let privileged = false;
  let cwd = directory;
  let body: string | undefined;
  let shellWithoutCommand = false;
  let wrapperAt: number | undefined;
  const writes: string[] = [];
  for (;;) {
    const head = words[start];
    if (!head) break;
    const name = posix.basename(head.text);
    if (name === "su") { privileged = true; reasons.add("inline-shell"); wrapperAt = start; start = words.length; break; }
    const wrapper = WRAPPERS[name];
    if (!wrapper) break;
    if (PRIVILEGE.has(name)) privileged = true;
    wrapperAt = start;
    const { next, found, assignments } = wrapperOptions(words, start + 1, wrapper, name === "env");
    if (name === "env") codeEnvironment ||= assignments.some(isCodeEnvironmentAssignment);
    const has = (set: ReadonlySet<string> | undefined) => found.some(({ option }) => set?.has(option));
    start = next;
    shellWithoutCommand = Boolean(wrapper.alwaysShell) || has(wrapper.shell);
    let shellBody: { text: string; expands: boolean } | undefined;
    let hasBody = false;
    for (const { option, value } of found) {
      if (wrapper.environment?.has(option) && value) codeEnvironment ||= isCodeEnvironmentAssignment(value.text);
      if (wrapper.root?.has(option)) reasons.add("changed-root");
      if (wrapper.chdir?.has(option)) {
        const path = value && !value.expands && !cwd.unknown ? resolveWord(value.text, cwd.path, real) : undefined;
        if (path === undefined) reasons.add("unresolved-directory");
        cwd = path === undefined ? { unknown: true } : { path, unknown: false };
      }
      if (wrapper.writes?.has(option) && value) writes.push(value.text);
      if (wrapper.body?.has(option)) { hasBody = true; shellBody = value; }
      if (wrapper.split?.has(option)) {
        reasons.add("split-string");
        body = `env ${value?.text ?? ""} ${words.slice(start).map(word => quoteWord(word.text)).join(" ")}`;
        start = words.length;
      }
    }
    if (body !== undefined) break;
    if (has(wrapper.attach)) reasons.add("process-attach");
    if (has(wrapper.noCommand)) { shellWithoutCommand = false; start = words.length; break; }
    if (!hasBody) {
      const count = Math.min(wrapper.operands ?? 0, words.length - start);
      if (wrapper.operandWrites && count > 0) writes.push(words[start].text);
      start += count;
      if (wrapper.body?.has(words[start]?.text ?? "")) { hasBody = true; shellBody = words[start + 1]; start += 2; }
    }
    if (hasBody) {
      if (wrapper.bodyOnly) writes.push(...words.slice(start).map(word => word.text));
      start = words.length;
      if (shellBody && !shellBody.expands) body = shellBody.text;
      else reasons.add("inline-shell");
    } else if (wrapper.bodyOnly) start = words.length;
    else if (wrapper.joined && !has(wrapper.exec) && start < words.length) {
      const rest = words.slice(start);
      start = words.length;
      if (rest.some(word => word.expands)) reasons.add("inline-shell");
      else body = rest.map(word => word.text).join(" ");
    }
    if (body !== undefined) break;
  }
  if (start >= words.length && body === undefined && wrapperAt !== undefined) {
    if (shellWithoutCommand) reasons.add("shell-from-input");
    start = wrapperAt;
  }
  const argv = words.slice(start).map(word => word.text);
  const nameWord = words[start];
  const name = nameWord ? posix.basename(nameWord.text) : "";
  if (name === "export" || name === "readonly"
    || (["declare", "typeset"].includes(name) && argv.slice(1).some(word => /^-[A-Za-z]*x[A-Za-z]*$/.test(word))))
    codeEnvironment ||= argv.slice(1).some(isCodeEnvironmentAssignment);
  if (codeEnvironment) reasons.add("code-environment");
  if (!argv.length && !redirects.length && body === undefined) return undefined;
  if (nameWord?.expands) reasons.add("variable-command");
  if (name === "ssh") reasons.add("remote-command");
  if (name === "sftp" || argv.slice(1).some(word => remoteOperand(name, word))
    || (name === "rsync" && argv.some(word => word === "--rsh" || word.startsWith("--rsh=") || /^-[A-Za-z0-9]*e/.test(word))))
    reasons.add("remote-target");
  if (name === "eval" || name === "source" || name === ".") reasons.add("eval");
  if (name === "xargs" || (name === "find" && argv.some(arg => ["-exec", "-execdir", "-ok", "-okdir", "-delete"].includes(arg)))) reasons.add("indirect-command");
  if (SHELLS.has(name)) {
    const string = shellCommandString(argv);
    if (string.command && string.literal && string.index < argv.length && !words[start + string.index]?.expands) body = argv[string.index];
    else if (string.command) reasons.add("inline-shell");
    else if (!argv.slice(1).some(arg => arg === "--version" || arg === "--help")) {
      const operands = argv.slice(1).filter(arg => !arg.startsWith("-") && !arg.startsWith("+"));
      reasons.add(operands.length === 0 || argv.includes("-s") ? "shell-from-input" : "shell-script");
    }
  }
  const interpreter = interpreterOf(name);
  if (interpreter) {
    const found = interpreterWords(INTERPRETERS[interpreter], argv);
    if (found.code) reasons.add("inline-code");
    else if (INTERPRETERS[interpreter].fromInput && (piped || hereString) && (found.dash || !found.script) && !found.mode) reasons.add("code-from-input");
  }
  if ((name === "pwsh" || name === "powershell") && argv.slice(1).some(arg => {
    const option = arg.toLowerCase().split(":")[0];
    return option.length >= 2 && (["-command", "-encodedcommand", "-commandwithargs"].some(full => full.startsWith(option)) || ["-ec", "-cwa"].includes(option));
  })) reasons.add("inline-code");
  if (/^[gmn]?awk$/.test(name) && argv.some(arg => /\bsystem\s*\(|\|\s*getline|\bprintf?\b[^;]*[>|]/.test(arg))) reasons.add("inline-code");
  if ((name === "sed" || name === "gsed") && sedScripts(argv).some(script => SED_EXECUTES.some(pattern => pattern.test(script)))) reasons.add("inline-code");
  if (name === "git" && gitCommandConfig(argv)) reasons.add("inline-code");
  return {
    argv, name, words: words.map(word => word.text), redirects, privileged,
    ...(cwd.path !== undefined && !cwd.unknown ? { cwd: cwd.path } : {}), ...(cwd.unknown ? { cwdUnknown: true } : {}),
    ...(writes.length ? { writes } : {}), ...(body !== undefined ? { body } : {}),
  };
}

function sedScripts(argv: readonly string[]): string[] {
  const scripts: string[] = [];
  let file = false;
  let operand: string | undefined;
  for (let index = 1; index < argv.length; index++) {
    const word = argv[index];
    if (word === "--") { operand ??= argv[index + 1]; break; }
    if (word.startsWith("--expression=")) scripts.push(word.slice(13));
    else if (word === "--expression") scripts.push(argv[++index] ?? "");
    else if (word === "--file" || word.startsWith("--file=")) { file = true; if (word === "--file") index++; }
    else if (word === "-l" || word === "--line-length") index++;
    else if (/^-[a-zA-Z]/.test(word) && !word.startsWith("--")) {
      for (let at = 1; at < word.length; at++) {
        const letter = word[at];
        if (letter === "e" || letter === "f") {
          const value = word.slice(at + 1) || argv[++index] || "";
          if (letter === "e") scripts.push(value); else file = true;
          break;
        }
        if (letter === "i" || letter === "l") break;
      }
    } else if (!word.startsWith("-")) operand ??= word;
  }
  if (!scripts.length && !file && operand !== undefined) scripts.push(operand);
  return scripts;
}

const SED_ADDRESS = String.raw`(?:\d+(?:~\d+)?|\$|/(?:[^/\\\n]|\\.)*/[IM]*)`;
const SED_COMMAND_START = String.raw`(?:^|[;\n{}])\s*(?:${SED_ADDRESS}(?:\s*,\s*(?:${SED_ADDRESS}|[+~]\d+))?)?\s*!?\s*`;
const SED_EXECUTES: readonly RegExp[] = [
  new RegExp(`${SED_COMMAND_START}e(?=\\s|;|}|$)`),
  new RegExp(String.raw`${SED_COMMAND_START}s([^\s\\\n])(?:(?!\1)[^\\\n]|\\.)*\1(?:(?!\1)[^\\\n]|\\.)*\1[gpiImM0-9]*e`),
];

const GIT_COMMAND_KEYS = /^(?:core\.(?:sshcommand|pager|editor|fsmonitor|hookspath|askpass)|credential\.helper|sequence\.editor|diff\.external|gpg\.program|pager\.[^=]+|include\.path)$/i;
const GIT_INERT = new Set(["", "true", "false", ":", "cat", "less", "/dev/null"]);

function gitCommandConfig(argv: readonly string[]): boolean {
  for (let index = 1; index < argv.length; index++) {
    const word = argv[index];
    if (!word.startsWith("-")) break;
    if (word !== "-c" && word !== "-C" && word !== "--config-env" && word !== "--git-dir" && word !== "--work-tree" && word !== "--namespace") continue;
    const value = argv[++index] ?? "";
    if (word !== "-c") continue;
    const equals = value.indexOf("=");
    const key = equals < 0 ? value : value.slice(0, equals);
    const setting = equals < 0 ? "true" : value.slice(equals + 1).trim();
    if (/^alias\./i.test(key) && setting.startsWith("!")) return true;
    if (GIT_COMMAND_KEYS.test(key) && !GIT_INERT.has(setting)) return true;
  }
  return false;
}

const REMOTE_COPY = new Set(["scp", "rsync", "sftp"]);

export function remoteOperand(name: string, word: string): boolean {
  return REMOTE_COPY.has(name) && !word.startsWith("-") && /^[^/]*:/.test(word);
}

export function quoteWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

export function resolveWord(word: string, cwd: string | undefined, real?: PathResolver): string | undefined {
  const home = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(word);
  if (home) {
    const rest = word.slice(home[0].length);
    if (rest.includes("$") || rest.includes("`")) return undefined;
    return `~${posix.normalize(`/${rest}`).replace(/\/$/, "")}`;
  }
  if (word.includes("$") || word.includes("`")) return undefined;
  if (word.startsWith("~")) return undefined;
  if (!posix.isAbsolute(word) && !cwd) return undefined;
  if (!posix.isAbsolute(word) && cwd!.startsWith("~")) return `~${posix.normalize(`/${cwd!.slice(1)}/${word}`).replace(/\/$/, "")}`;
  const raw = posix.isAbsolute(word) ? word : `${cwd}/${word}`;
  return real?.(raw) ?? posix.resolve(raw);
}

export type PathResolver = (path: string) => string | undefined;

const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

export function realHostPath(path: string, depth = 0): string | undefined {
  if (!posix.isAbsolute(path) || depth > 8) return undefined;
  let current = path;
  const rest: string[] = [];
  for (let step = 0; step < 256; step++) {
    try {
      const real = realpathSync.native(current);
      return rest.length ? posix.join(real, ...rest) : real;
    } catch (error) { if (!missing(error)) return undefined; }
    let link: string | undefined;
    try { if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current); }
    catch (error) { if (!missing(error)) return undefined; }
    if (link !== undefined) return realHostPath([posix.isAbsolute(link) ? link : `${posix.dirname(current)}/${link}`, ...rest].join("/"), depth + 1);
    const parent = posix.dirname(current);
    if (parent === current) return undefined;
    rest.unshift(posix.basename(current));
    current = parent;
  }
  return undefined;
}
