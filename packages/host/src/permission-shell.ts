/**
 * A small, conservative reading of a shell command for the permission agent's host rules. It never runs
 * anything. It establishes the simple commands, their operands and redirections where the text shows
 * them literally, and marks the command opaque where an effect is hidden: command substitution, eval,
 * inline interpreter code, here-documents, process substitution, or a variable in command position.
 */
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
  /** The working directory the text establishes for this command, when a literal `cd` set it. */
  cwd?: string;
  /** For `sh -c SCRIPT`: the script word contains an expansion, so the script it runs is not literal. */
  scriptExpands?: boolean;
}

export interface ShellReading {
  commands: SimpleCommand[];
  opaque: boolean;
  /** Why the reading is opaque, for the record. */
  opaqueReasons: string[];
}

type Token = { kind: "word"; text: string; expands: boolean } | { kind: "op"; text: string };

const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", "\n", "(", ")"]);
const REDIRECTS = new Set([">", ">>", "<", ">|", "&>", "&>>", "<>", ">&", "<&", "<<<"]);
const PRIVILEGE = new Set(["sudo", "doas", "su", "pkexec", "run0"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INLINE_CODE: Record<string, readonly string[]> = {
  python: ["-c"], node: ["-e", "-p", "--eval", "--print"], deno: ["eval"], bun: ["-e", "--eval"],
  perl: ["-e", "-E"], ruby: ["-e"], php: ["-r"], osascript: ["-e"], lua: ["-e"],
};
/** Wrappers whose own options come before the command they run. The value is the set of options that take a value. */
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "--user", "--group", "--chdir", "--host", "--prompt"]),
  doas: new Set(["-u", "-C"]),
  pkexec: new Set(["--user"]),
  run0: new Set(["-u", "--user", "-D", "--chdir"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  nohup: new Set(), time: new Set(), command: new Set(), builtin: new Set(), exec: new Set(["-a"]),
  nice: new Set(["-n", "--adjustment"]), ionice: new Set(["-c", "-n", "-p"]), stdbuf: new Set(["-i", "-o", "-e"]),
  caffeinate: new Set(["-t", "-w"]), chronic: new Set(), unbuffer: new Set(),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
};

/** Reads one command line. `cwd` is the directory the host assigned; a literal `cd` moves it for later commands. */
export function readShell(source: string, cwd?: string): ShellReading {
  const reasons = new Set<string>();
  const tokens = lex(source, reasons);
  const commands: SimpleCommand[] = [];
  let current: Token[] = [];
  let directory = cwd;
  const flush = () => {
    if (!current.length) return;
    const command = build(current, reasons, directory);
    current = [];
    if (!command) return;
    if ((command.name === "cd" || command.name === "pushd") && command.argv.length <= 2) {
      const target = command.argv[1];
      directory = target === undefined ? undefined : resolveWord(target, directory);
    }
    commands.push(command);
  };
  for (const token of tokens) {
    if (token.kind === "op" && SEPARATORS.has(token.text)) flush();
    else current.push(token);
  }
  flush();
  return { commands, opaque: reasons.size > 0, opaqueReasons: [...reasons] };
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

function build(tokens: Token[], reasons: Set<string>, cwd: string | undefined): SimpleCommand | undefined {
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
  for (;;) {
    const head = words[start];
    if (!head) break;
    const name = posix.basename(head.text);
    if (name === "su") { privileged = true; reasons.add("inline-shell"); start = words.length; break; }
    const valued = WRAPPERS[name];
    if (!valued) break;
    if (PRIVILEGE.has(name)) privileged = true;
    start++;
    if (name === "timeout") {
      while (words[start]?.text.startsWith("-")) start += valued.has(words[start].text) ? 2 : 1;
      start++; // the duration
      continue;
    }
    while (words[start]) {
      const text = words[start].text;
      if (text === "--") { start++; break; }
      if (name === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) { start++; continue; }
      if (!text.startsWith("-")) break;
      start += valued.has(text) ? 2 : 1;
    }
  }
  const argv = words.slice(start).map(word => word.text);
  if (!argv.length && !redirects.length) return undefined;
  const nameWord = words[start];
  const name = nameWord ? posix.basename(nameWord.text) : "";
  if (nameWord?.expands) reasons.add("variable-command");
  if (name === "eval" || name === "source" || name === ".") reasons.add("eval");
  if (name === "xargs" || (name === "find" && argv.some(arg => ["-exec", "-execdir", "-ok", "-okdir", "-delete"].includes(arg)))) reasons.add("indirect-command");
  // A shell with one literal script is read as that script by the caller; any other inline shell is opaque.
  const literalScript = inlineShellScript(argv) !== undefined && !words[start + 2]?.expands;
  if (SHELLS.has(name) && !literalScript && argv.some(arg => /^-[a-z]*c[a-z]*$/.test(arg))) reasons.add("inline-shell");
  if (SHELLS.has(name) && argv.length === 1 && !redirects.length) reasons.add("shell-from-input");
  if (SHELLS.has(name) && argv.length >= 1 && redirects.some(redirect => redirect.op === "<")) reasons.add("shell-from-input");
  const inline = INLINE_CODE[/^python\d*(?:\.\d+)*$/.test(name) ? "python" : name];
  if (inline?.some(flag => argv.includes(flag))) reasons.add("inline-code");
  if ((name === "awk" || name === "gawk") && argv.some(arg => /\bsystem\s*\(|\|\s*getline|print[^;]*>/.test(arg))) reasons.add("inline-code");
  return {
    argv, name, words: words.map(word => word.text), redirects, privileged, ...(cwd ? { cwd } : {}),
    ...(inlineShellScript(argv) !== undefined && words[start + 2]?.expands ? { scriptExpands: true } : {}),
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
export function resolveWord(word: string, cwd: string | undefined): string | undefined {
  const home = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(word);
  if (home) {
    const rest = word.slice(home[0].length);
    if (rest.includes("$") || rest.includes("`")) return undefined;
    return `~${posix.normalize(`/${rest}`).replace(/\/$/, "")}`;
  }
  if (word.includes("$") || word.includes("`")) return undefined;
  if (word.startsWith("~")) return undefined; // another user's home
  if (posix.isAbsolute(word)) return posix.normalize(word);
  return cwd ? posix.resolve(cwd, word) : undefined;
}
