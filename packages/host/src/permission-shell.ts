/**
 * A small, conservative reading of a shell command for the permission agent's host rules. It never runs
 * anything. It establishes the simple commands, their operands and redirections where the text shows
 * them literally, and marks the command opaque where an effect is hidden: command substitution, eval,
 * inline interpreter code, here-documents, process substitution, a variable in command position, a
 * shell whose body is not literal text, or a working directory the text does not establish.
 *
 * A literal shell body (`sh -c 'script'`, `env -S 'string'`) is read as the commands it runs, to
 * `MAX_SHELL_DEPTH` layers; a deeper body is opaque.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { posix } from "node:path";

export interface SimpleCommand {
  /** The words after leading assignments and wrappers such as sudo, env or timeout. */
  argv: string[];
  /** The command name: the basename of argv[0], or "" for none. */
  name: string;
  /** All words as written, wrappers included. */
  words: string[];
  redirects: Array<{ op: string; target: string }>;
  /** A wrapper that runs the command as another user: sudo, doas, su, pkexec or run0. */
  privileged: boolean;
  /** The working directory the text establishes for this command: the caller's, a literal `cd`, or a wrapper's `-C`/`-D`. */
  cwd?: string;
  /** The text changes the working directory in a way the host cannot establish; relative paths are then unknown. */
  cwdUnknown?: boolean;
}

export interface ShellReading {
  commands: SimpleCommand[];
  opaque: boolean;
  /** Why the reading is opaque, for the record. */
  opaqueReasons: string[];
}

type Token = { kind: "word"; text: string; expands: boolean } | { kind: "op"; text: string };

/** Literal shell bodies inside shell bodies are read to this depth. A body below it is opaque. */
export const MAX_SHELL_DEPTH = 3;

const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", "\n", "(", ")"]);
const REDIRECTS = new Set([">", ">>", "<", ">|", "&>", "&>>", "<>", ">&", "<&", "<<<"]);
const PRIVILEGE = new Set(["sudo", "doas", "su", "pkexec", "run0"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INLINE_CODE: Record<string, readonly string[]> = {
  python: ["-c"], node: ["-e", "-p", "--eval", "--print"], deno: ["eval"], bun: ["-e", "--eval"],
  perl: ["-e", "-E"], ruby: ["-e"], php: ["-r"], osascript: ["-e"], lua: ["-e"],
};
/**
 * Wrappers whose own options come before the command they run. `valued` are the options that take a
 * value. `chdir` options run the command in another directory, `root` options in another root
 * directory, and `split` options run a string as the command line. `shell` options, or `alwaysShell`,
 * start a shell that reads its commands from input when no command follows.
 */
interface Wrapper {
  valued: ReadonlySet<string>;
  chdir?: ReadonlySet<string>;
  root?: ReadonlySet<string>;
  split?: ReadonlySet<string>;
  shell?: ReadonlySet<string>;
  alwaysShell?: boolean;
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
    chdir: options("-D", "--chdir"), alwaysShell: true },
  env: { valued: options("-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"), chdir: options("-C", "--chdir"), split: options("-S", "--split-string") },
  nohup: { valued: options() }, time: { valued: options() }, command: { valued: options() }, builtin: { valued: options() }, exec: { valued: options("-a") },
  nice: { valued: options("-n", "--adjustment") }, ionice: { valued: options("-c", "-n", "-p") }, stdbuf: { valued: options("-i", "-o", "-e") },
  caffeinate: { valued: options("-t", "-w") }, chronic: { valued: options() }, unbuffer: { valued: options() },
  timeout: { valued: options("-s", "--signal", "-k", "--kill-after") },
};

/** The working directory a reading has established: a path, none (the caller gave none), or unknown. */
type Directory = { path?: string; unknown: boolean };

/** Reads one command line. `cwd` is the directory the host assigned; a literal `cd` moves it for later commands. */
export function readShell(source: string, cwd?: string, real?: PathResolver): ShellReading {
  const reasons = new Set<string>();
  const commands = readLine(source, { path: cwd, unknown: false }, real, 0, reasons);
  return { commands, opaque: reasons.size > 0, opaqueReasons: [...reasons] };
}

function readLine(source: string, start: Directory, real: PathResolver | undefined, depth: number, reasons: Set<string>): SimpleCommand[] {
  const tokens = lex(source, reasons);
  const commands: SimpleCommand[] = [];
  let current: Token[] = [];
  let directory = start;
  const flush = () => {
    if (!current.length) return;
    const built = build(current, reasons, directory, real);
    current = [];
    if (!built) return;
    const { body, ...command } = built;
    if (body !== undefined) {
      if (depth >= MAX_SHELL_DEPTH) { reasons.add("shell-depth"); commands.push(command); return; }
      // The body runs in its own shell: its commands inherit this one's directory and privilege, and a `cd` in it ends with it.
      const inner = readLine(body, { path: command.cwd, unknown: Boolean(command.cwdUnknown) }, real, depth + 1, reasons);
      for (const nested of inner) commands.push(command.privileged ? { ...nested, privileged: true } : nested);
      if (command.redirects.length) commands.push({ ...command, argv: [], name: "", words: [] });
      return;
    }
    if (command.name === "cd" || command.name === "pushd" || command.name === "popd") directory = changeDirectory(command, directory, real, reasons);
    commands.push(command);
  };
  for (const token of tokens) {
    if (token.kind === "op" && SEPARATORS.has(token.text)) flush();
    else current.push(token);
  }
  flush();
  return commands;
}

/** The directory after `cd`, `pushd` or `popd`. One the text does not establish is unknown, never the previous one. */
function changeDirectory(command: SimpleCommand, directory: Directory, real: PathResolver | undefined, reasons: Set<string>): Directory {
  const operands = command.argv.slice(1).filter(arg => arg !== "-L" && arg !== "-P" && arg !== "--");
  if (command.name === "cd" && operands.length === 0) return { path: "~", unknown: false };
  // `cd -`, `pushd +N`, `pushd` alone and `popd` go to a directory from the shell's history, which the text does not show.
  const target = operands.length === 1 && !/^[-+]/.test(operands[0]) && command.name !== "popd" ? operands[0] : undefined;
  const path = target === undefined || directory.unknown ? undefined : resolveWord(target, directory.path, real);
  if (path !== undefined) return { path, unknown: false };
  reasons.add("unresolved-directory");
  return { unknown: true };
}

/** A wrapper's options, getopt style: `-abc` are flags until one takes a value, which is the rest of the word or the next word. */
function wrapperOptions(words: ReadonlyArray<{ text: string; expands: boolean }>, start: number, wrapper: Wrapper, env: boolean) {
  const found: Array<{ option: string; value?: { text: string; expands: boolean } }> = [];
  let index = start;
  while (words[index]) {
    const text = words[index].text;
    if (text === "--") { index++; break; }
    if (env && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) || text === "-")) { index++; continue; }
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
  return { next: index, found };
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
      // A digit directly before a redirection is its file descriptor, not a word.
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

type Built = SimpleCommand & { body?: string };

function build(tokens: Token[], reasons: Set<string>, directory: Directory, real: PathResolver | undefined): Built | undefined {
  const words: Array<{ text: string; expands: boolean }> = [];
  const redirects: SimpleCommand["redirects"] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "op") {
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
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start].text)) start++;
  let privileged = false;
  let cwd = directory;
  let body: string | undefined;
  let shellWithoutCommand = false;
  for (;;) {
    const head = words[start];
    if (!head) break;
    const name = posix.basename(head.text);
    if (name === "su") { privileged = true; reasons.add("inline-shell"); start = words.length; break; }
    const wrapper = WRAPPERS[name];
    if (!wrapper) break;
    if (PRIVILEGE.has(name)) privileged = true;
    const { next, found } = wrapperOptions(words, start + 1, wrapper, name === "env");
    start = next;
    if (name === "timeout") start++; // the duration
    shellWithoutCommand = Boolean(wrapper.alwaysShell) || found.some(({ option }) => wrapper.shell?.has(option));
    for (const { option, value } of found) {
      if (wrapper.root?.has(option)) reasons.add("changed-root");
      if (wrapper.chdir?.has(option)) {
        // The command runs in that directory: its relative paths resolve there, or are unknown.
        const path = value && !value.expands && !cwd.unknown ? resolveWord(value.text, cwd.path, real) : undefined;
        if (path === undefined) reasons.add("unresolved-directory");
        cwd = path === undefined ? { unknown: true } : { path, unknown: false };
      }
      if (wrapper.split?.has(option)) {
        // `env -S STRING ARGS` runs STRING split into words, followed by ARGS. The string has its own escapes.
        reasons.add("split-string");
        body = `env ${value?.text ?? ""} ${words.slice(start).map(word => quoteWord(word.text)).join(" ")}`;
        start = words.length;
      }
    }
    if (body !== undefined) break;
  }
  const argv = words.slice(start).map(word => word.text);
  if (!argv.length && shellWithoutCommand) reasons.add("shell-from-input");
  if (!argv.length && !redirects.length && body === undefined) return undefined;
  const nameWord = words[start];
  const name = nameWord ? posix.basename(nameWord.text) : "";
  if (nameWord?.expands) reasons.add("variable-command");
  if (name === "eval" || name === "source" || name === ".") reasons.add("eval");
  if (name === "xargs" || (name === "find" && argv.some(arg => ["-exec", "-execdir", "-ok", "-okdir", "-delete"].includes(arg)))) reasons.add("indirect-command");
  if (SHELLS.has(name)) {
    // A shell with one literal script runs that script: it is read as a body. Any other shell's body is not literal.
    const script = inlineShellScript(argv);
    if (script !== undefined && !words[start + 2]?.expands) body = script;
    else if (argv.some(arg => /^-[a-z]*c[a-z]*$/.test(arg))) reasons.add("inline-shell");
    else if (!argv.slice(1).some(arg => arg === "--version" || arg === "--help")) {
      const operands = argv.slice(1).filter(arg => !arg.startsWith("-") && !arg.startsWith("+"));
      reasons.add(operands.length === 0 || argv.includes("-s") ? "shell-from-input" : "shell-script");
    }
  }
  const inline = INLINE_CODE[/^python\d*(?:\.\d+)*$/.test(name) ? "python" : name];
  if (inline?.some(flag => argv.includes(flag))) reasons.add("inline-code");
  if ((name === "awk" || name === "gawk") && argv.some(arg => /\bsystem\s*\(|\|\s*getline|print[^;]*>/.test(arg))) reasons.add("inline-code");
  return {
    argv, name, words: words.map(word => word.text), redirects, privileged,
    ...(cwd.path !== undefined && !cwd.unknown ? { cwd: cwd.path } : {}), ...(cwd.unknown ? { cwdUnknown: true } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

/**
 * The shell script of `sh -c 'script'` when the command is exactly a shell with one literal script, as
 * Codex sends `["bash", "-lc", "..."]`. Undefined otherwise.
 */
export function inlineShellScript(argv: readonly string[]): string | undefined {
  if (argv.length !== 3 || !SHELLS.has(posix.basename(argv[0])) || !/^-[a-z]*c[a-z]*$/.test(argv[1])) return undefined;
  return argv[2];
}

/** Quotes one word for display and for a second reading. */
export function quoteWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * A literal path word resolved against `cwd`. `~` and `$HOME` stay symbolic (`~/...`) because the
 * requester's home is not the host's fact. Undefined when the word has another expansion or no base.
 */
export function resolveWord(word: string, cwd: string | undefined, real?: PathResolver): string | undefined {
  const home = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(word);
  if (home) {
    const rest = word.slice(home[0].length);
    if (rest.includes("$") || rest.includes("`")) return undefined;
    return `~${posix.normalize(`/${rest}`).replace(/\/$/, "")}`;
  }
  if (word.includes("$") || word.includes("`")) return undefined;
  if (word.startsWith("~")) return undefined; // another user's home
  if (!posix.isAbsolute(word) && !cwd) return undefined;
  if (!posix.isAbsolute(word) && cwd!.startsWith("~")) return `~${posix.normalize(`/${cwd!.slice(1)}/${word}`).replace(/\/$/, "")}`;
  // The raw path keeps its `..` words, so a resolver follows a link before it steps up from it.
  const raw = posix.isAbsolute(word) ? word : `${cwd}/${word}`;
  return real?.(raw) ?? posix.resolve(raw);
}

/**
 * Maps a raw absolute path, with its `..` words, to the path the host rules judge. Undefined when the
 * host cannot establish it.
 */
export type PathResolver = (path: string) => string | undefined;

const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * The real path of an absolute host path. Symbolic links are followed through the deepest part that
 * exists, a dangling link is followed to where a write through it lands, and the part that does not
 * exist is appended as written. A live decision core reads targets and session roots through it, so a
 * link inside the session root cannot hide a target outside it. Undefined when a part cannot be read.
 */
export function realHostPath(path: string, depth = 0): string | undefined {
  if (!posix.isAbsolute(path) || depth > 8) return undefined;
  let current = path;
  const rest: string[] = [];
  for (let step = 0; step < 256; step++) {
    try {
      // The native call follows a link before it steps up from it; Node's own version removes `..` first.
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
