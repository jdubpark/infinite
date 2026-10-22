import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const loader = resolve("deploy/ubuntu/agent-env.sh");

const anchorCheck = resolve("deploy/ubuntu/agent-anchor.sh");
const shells = ["/bin/sh", ...["dash", "bash"].filter((shell) => spawnSync(shell, ["-c", ":"]).status === 0)];

function runLoader(root: string, projectId: string, shell = "/bin/sh", extraArgs: string[] = []) {
  const result = spawnSync(shell, [...extraArgs, "-c", 'set -eu; . "$1"; infinite_load_env "$2" "$3"; env', "sh", loader, root, projectId], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const values = new Map<string, string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals > 0) values.set(line.slice(0, equals), line.slice(equals + 1));
  }
  return { values, stderr: result.stderr };
}

test("owner-managed environment files load safely in sorted, layered order", () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-agent-env-"));
  try {
    mkdirSync(join(root, "secrets"));
    mkdirSync(join(root, "projects"));
    writeFileSync(join(root, "secrets", "a.env"), [
      "# host credentials",
      "EXPO_TOKEN=host-token",
      "ORDER=first",
      "SAME=secret",
      "PATH_APPEND=/host/bin",
      "PATH=/blocked",
      "HOME=/blocked",
      "INFINITE_X=blocked",
      "INFINITE_PROJECT_ID=blocked",
      "SUDO_USER=blocked",
      "XDG_DATA_HOME=/blocked",
      "LD_PRELOAD=/blocked",
      "npm_config_prefix=/blocked",
      "provider=blocked",
      "1BAD=x",
      "no_equals",
      "KEY = spaced",
      "LITERAL=$(touch pwned)",
      "VALUE_EQUALS=first=second",
      "_infinite_env_project_id=other",
      "_infinite_env_dir=/nonexistent",
      "OPTIND=not-a-number",
      "IFS=x",
      "SHELLOPTS=errexit",
      "HISTCMD=not-a-number",
      "FUNCNAME=value",
      "CRLF=value\r",
      "",
    ].join("\n"));
    mkdirSync(join(root, "projects", "other"), { recursive: true });
    writeFileSync(join(root, "projects", "other.env"), "HIJACKED=yes\n");
    writeFileSync(join(root, "secrets", "b.env"), "ORDER=last\nSAME=secret-last\n");
    writeFileSync(join(root, "secrets", "world.env"), "WORLD_SECRET=must-skip\n", { mode: 0o666 });
    chmodSync(join(root, "secrets", "world.env"), 0o666);
    writeFileSync(join(root, "android.env"), "ANDROID_HOME=/opt/android\nJAVA_HOME=/opt/java\nSAME=android\nPATH_APPEND=/android/bin\n");
    writeFileSync(join(root, "projects", "p1.env"), "SAME=project\nPROJECT_ONLY=project-value\nPATH_APPEND=/project/bin\n");

    const { values, stderr } = runLoader(root, "p1");
    assert.equal(values.get("EXPO_TOKEN"), "host-token");
    assert.equal(values.get("ANDROID_HOME"), "/opt/android");
    assert.equal(values.get("JAVA_HOME"), "/opt/java");
    assert.equal(values.get("SAME"), "project", "project values override Android and host-wide values");
    assert.equal(values.get("ORDER"), "last", "secret files are read in sorted pathname order");
    assert.equal(values.get("PROJECT_ONLY"), "project-value");
    assert.equal(values.get("PATH"), `${process.env.PATH ?? "/usr/bin:/bin"}:/host/bin:/android/bin:/project/bin`);
    assert.equal(values.get("LITERAL"), "$(touch pwned)");
    assert.equal(values.get("VALUE_EQUALS"), "first=second");
    assert.equal(values.has("HOME"), false);
    for (const denied of ["INFINITE_X", "INFINITE_PROJECT_ID", "SUDO_USER", "XDG_DATA_HOME", "LD_PRELOAD", "npm_config_prefix", "provider"])
      assert.equal(values.has(denied), false, `${denied} is denied`);
    for (const malformed of ["1BAD", "no_equals", "KEY "]) assert.equal(values.has(malformed), false);
    for (const special of ["_infinite_env_project_id", "_infinite_env_dir", "OPTIND", "IFS"])
      assert.equal(values.has(special), false, `${special} is denied`);
    assert.equal(values.has("HIJACKED"), false, "a file key cannot redirect project selection");
    assert.equal(values.get("CRLF"), "value", "a trailing carriage return is stripped");
    assert.equal(values.has("WORLD_SECRET"), false);
    assert.match(stderr, new RegExp(`infinite_load_env: skipping ${join(root, "secrets", "world.env")}: world-writable`));
    for (const shell of shells) {
      const posixArgs = shell === "bash" ? ["--posix"] : [];
      const run = runLoader(root, "p1", shell, posixArgs);
      assert.equal(run.values.get("PROJECT_ONLY"), "project-value", `${shell}: hostile shell-special keys do not abort loading`);
      for (const fatal of ["SHELLOPTS", "HISTCMD", "FUNCNAME"]) assert.notEqual(run.values.get(fatal), "errexit", `${shell}: ${fatal}`);
    }
    assert.equal(existsSync(join(root, "pwned")), false, "value text is never evaluated");

    assert.equal(runLoader(root, "missing").values.has("PROJECT_ONLY"), false, "a missing project file is harmless");
    assert.equal(runLoader(root, "").values.has("PROJECT_ONLY"), false, "an empty project id is harmless");
    assert.equal(runLoader(root, "bad/id").values.has("PROJECT_ONLY"), false, "unsafe project ids do not select a file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the installer accepts only a single top-level export SHELL anchor", () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-anchor-"));
  const check = (body: string) => {
    const file = join(root, "wrapper.sh");
    writeFileSync(file, body);
    return spawnSync("/bin/sh", ["-c", '. "$1"; infinite_wrapper_anchor_ok "$2"', "sh", anchorCheck, file]).status;
  };
  try {
    assert.equal(check("#!/bin/sh\nexport PATH=/x\nexport SHELL=/bin/bash\nf() {\n  :\n}\nexec provider\n"), 0, "top-level anchor before functions");
    assert.equal(check('#!/bin/sh\nlabel="{"\nexport SHELL=/bin/bash\nexec provider\n'), 0, "braces inside quotes are ignored");
    assert.notEqual(check("unused() {\nexport SHELL=/bin/bash\n}\nexec provider\n"), 0, "anchor inside a function is refused");
    assert.notEqual(check("export SHELL=/bin/bash\nexport SHELL=/bin/bash\n"), 0, "two anchors are refused");
    assert.notEqual(check("if true; then\n  export SHELL=/bin/bash\nfi\n"), 0, "an indented anchor is refused");
    assert.notEqual(check("exec provider\n"), 0, "a missing anchor is refused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the installer proves the hook executes by running the wrapper in self-test mode", () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-hook-"));
  const hook = `. "${loader}" && infinite_load_env "${root}" ""`;
  const tail = 'provider=$(basename "$0")\ncase "$provider" in\n  claude) echo PROVIDER-REACHED ;;\n  *) printf "Unknown agent launcher\\n" >&2; exit 64 ;;\nesac\necho PROVIDER-REACHED\n';
  const proven = (name: string, body: string) => {
    const file = join(root, name);
    writeFileSync(file, body, { mode: 0o755 });
    chmodSync(file, 0o755);
    const result = spawnSync("/bin/sh", ["-c", '. "$1"; infinite_wrapper_hook_proven "$2"', "sh", anchorCheck, file], { encoding: "utf8" });
    return { proven: result.status === 0, status: result.status, out: result.stdout + result.stderr };
  };
  try {
    mkdirSync(join(root, "secrets"));
    assert.equal(proven("good.probe", `#!/bin/sh\nset -eu\nexport SHELL=/bin/bash\n${hook}\n${tail}`).proven, true, "a top-level hook is proven");
    assert.equal(proven("heredoc.probe", `#!/bin/sh\nset -eu\ncat <<'HELP' >/dev/null\nexport SHELL=/bin/bash\n${hook}\nHELP\n${tail}`).proven, false, "a hook inside heredoc text is not proven");
    assert.equal(proven("comment-brace.probe", `#!/bin/sh\nset -eu\nunused() { # }\nexport SHELL=/bin/bash\n${hook}\n}\n${tail}`).proven, false, "a hook inside a function is not proven");
    assert.equal(proven("claude", `#!/bin/sh\n${tail}`).status, 2, "a provider-named file is never executed");
    for (const name of ["heredoc.probe", "comment-brace.probe"]) {
      const file = join(root, name);
      const run = spawnSync("/bin/sh", ["-c", 'INFINITE_AGENT_ENV_SELFTEST=1 "$1"', "sh", file], { encoding: "utf8" });
      assert.doesNotMatch(run.stdout, /PROVIDER-REACHED/, `${name}: the self-test never reaches a provider launch`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
