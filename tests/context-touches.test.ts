import test from "node:test";
import assert from "node:assert/strict";
import {
  ContextTouches,
  extractTouches,
  type TouchPage,
  type TouchSource,
} from "../packages/host/src/context-touches.js";

const CWD = "/home/dev/projects/example";

type Event = TouchPage["events"][number];

const source = (overrides: Partial<TouchSource> = {}): TouchSource => ({
  sessionId: "s1",
  cwd: CWD,
  provider: "claude",
  projectId: "p1",
  ...overrides,
});

const iso = (seq: number) => new Date(Date.UTC(2026, 10, 13, 0, 0, seq)).toISOString();

function toolStart(seq: number, tool: string, input: Record<string, unknown>): Event {
  return {
    seq,
    at: iso(seq),
    type: "signal",
    data: { kind: "tool-start", source: "hook", tool, toolUseId: `t${seq}`, input, quiet: false },
  };
}

/** An in-memory journal reader that honours `after` and a page size, like the vault reader. */
function journal(events: Event[], pageSize = 200) {
  const reads: number[] = [];
  const read = (_sessionId: string, after: number): TouchPage => {
    reads.push(after);
    const rest = events.filter((event) => event.seq > after);
    const page = rest.slice(0, pageSize);
    const cursor = page.length ? page[page.length - 1].seq : after;
    return { events: page, cursor, more: rest.length > page.length };
  };
  return { read, reads };
}

const noAreas = () => undefined;
const areaSet = (...dirs: string[]) => () => new Set(dirs);
const never = () => false;

test("file tools", () => {
  assert.deepEqual(extractTouches("Read", { file_path: "src/a.ts" }, CWD, never), {
    reads: ["src/a.ts"],
    edits: [],
    graphQuery: false,
  });
  assert.deepEqual(
    extractTouches("Read", { file_path: `${CWD}/packages/host/src/teams.ts` }, CWD, never).reads,
    ["packages/host/src/teams.ts"],
  );
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    assert.deepEqual(extractTouches(tool, { file_path: "src/b.ts" }, CWD, never), {
      reads: [],
      edits: ["src/b.ts"],
      graphQuery: false,
    }, tool);
  }
  assert.deepEqual(extractTouches("NotebookEdit", { notebook_path: "notebooks/x.ipynb" }, CWD, never).edits, [
    "notebooks/x.ipynb",
  ]);
  assert.deepEqual(extractTouches("Edit", { old_string: "a" }, CWD, never), {
    reads: [],
    edits: [],
    graphQuery: false,
  });
  assert.deepEqual(extractTouches("Read", { file_path: 42 }, CWD, never).reads, []);
});

test("apply_patch headers", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@",
    "-old",
    "+new",
    "*** Add File: docs/new.md",
    "+hello",
    "*** Move to: src/b.ts",
    "*** Delete File: old/c.ts",
    "*** End Patch",
  ].join("\n");
  const found = extractTouches("apply_patch", { input: patch }, CWD, never);
  assert.deepEqual(found.reads, []);
  assert.deepEqual(found.edits, ["src/a.ts", "docs/new.md", "src/b.ts", "old/c.ts"]);

  // Patch text inside an array is still read; text without the Begin marker is not.
  const nested = extractTouches(
    "apply_patch",
    { patches: ["*** Begin Patch\n*** Add File: arr.ts\n*** End Patch"] },
    CWD,
    never,
  );
  assert.deepEqual(nested.edits, ["arr.ts"]);
  const bare = extractTouches("apply_patch", { input: "*** Update File: bare.ts" }, CWD, never);
  assert.deepEqual(bare.edits, []);
});

test("paths inside a Git directory are never touches", () => {
  const everything = () => true;
  assert.deepEqual(extractTouches("Read", { file_path: ".git/infinite-team-context.json" }, CWD, everything).reads, []);
  assert.deepEqual(extractTouches("Read", { file_path: "sub/.git/config" }, CWD, everything).reads, []);
  assert.deepEqual(extractTouches("Bash", { command: "cat .git/hooks/pre-commit.sample" }, CWD, everything).reads, []);

  // Names that only start with a dot-git prefix are repository content.
  assert.deepEqual(extractTouches("Read", { file_path: ".github/workflows/ci.yml" }, CWD, everything).reads, [
    ".github/workflows/ci.yml",
  ]);
  assert.deepEqual(extractTouches("Read", { file_path: ".gitignore" }, CWD, everything).reads, [".gitignore"]);
});

test("shell tokens need a code area", () => {
  const command = 'cat "packages/host/src/teams.ts" && sed -n 1p docs/a.md; cat ../secret/x.ts';
  assert.deepEqual(extractTouches("Bash", { command }, CWD, never).reads, []);

  const areas = (directory: string) => directory === "packages/host/src";
  assert.deepEqual(extractTouches("Bash", { command }, CWD, areas).reads, ["packages/host/src/teams.ts"]);

  // A token without a slash, a dotfile, and an extensionless name are never reads.
  const loose = "cat README.md packages/host/src/.env packages/host/src/Makefile";
  assert.deepEqual(extractTouches("Bash", { command: loose }, CWD, () => true).reads, []);

  // An absolute token counts only under cwd; a sibling directory sharing the prefix does not.
  const absolute = `cat ${CWD}/packages/host/src/teams.ts /home/dev/projects/examplex/packages/host/src/teams.ts`;
  assert.deepEqual(extractTouches("Bash", { command: absolute }, CWD, areas).reads, [
    "packages/host/src/teams.ts",
  ]);

  // The array form is joined with spaces.
  assert.deepEqual(
    extractTouches("exec_command", { cmd: "cat packages/host/src/teams.ts" }, CWD, areas).reads,
    ["packages/host/src/teams.ts"],
  );
  assert.deepEqual(
    extractTouches("shell", { command: ["cat", "packages/host/src/teams.ts"] }, CWD, areas).reads,
    ["packages/host/src/teams.ts"],
  );
});

test("graphify commands are counted", async () => {
  assert.equal(extractTouches("Bash", { command: "graphify query 'auth' && graphify path a b" }, CWD, never).graphQuery, true);
  assert.equal(extractTouches("Bash", { command: "graphify explain x" }, CWD, never).graphQuery, true);
  assert.equal(extractTouches("Bash", { command: "graphify update ." }, CWD, never).graphQuery, false);
  assert.equal(extractTouches("Bash", { command: "mygraphify query x" }, CWD, never).graphQuery, false);

  const touches = new ContextTouches({
    read: journal([
      toolStart(1, "Bash", { command: "graphify query 'auth' && graphify path a b" }),
      toolStart(2, "Bash", { command: "graphify update ." }),
      toolStart(3, "Bash", { command: "graphify explain x" }),
    ]).read,
    areas: noAreas,
  });
  assert.equal((await touches.session(source())).graphQueries, 2);
});

test("path confinement", async () => {
  const outside = [
    { tool: "Read", input: { file_path: "/etc/passwd" } },
    { tool: "Read", input: { file_path: "/home/dev/projects/examplex/a.ts" } },
    { tool: "Read", input: { file_path: CWD } },
    { tool: "Read", input: { file_path: "../x" } },
    { tool: "Read", input: { file_path: "src/../../x.ts" } },
    { tool: "Read", input: { file_path: "src/a\u0000.ts" } },
    { tool: "Edit", input: { file_path: "../../outside.ts" } },
    // A path the recorder cut short names no real file.
    { tool: "Read", input: { file_path: "src/very/long … [+120 chars]" } },
    { tool: "apply_patch", input: { input: "*** Begin Patch\n*** Update File: ../x.ts\n*** End Patch" } },
    { tool: "Bash", input: { command: "cat ../x.ts /etc/hosts.conf" } },
  ];
  for (const { tool, input } of outside) {
    const found = extractTouches(tool, input, CWD, () => true);
    assert.deepEqual([...found.reads, ...found.edits], [], `${tool} ${JSON.stringify(input)}`);
  }

  // Controls: the same shapes inside cwd are kept.
  assert.deepEqual(extractTouches("Read", { file_path: `${CWD}/src/a.ts` }, CWD, never).reads, ["src/a.ts"]);
  assert.deepEqual(extractTouches("Read", { file_path: "./src/a.ts" }, CWD, never).reads, ["src/a.ts"]);

  const index = new ContextTouches({
    read: journal(outside.map((item, i) => toolStart(i + 1, item.tool, item.input))
      .concat([toolStart(20, "Read", { file_path: "src/a.ts" })])).read,
    areas: () => new Set(["."]),
  });
  const result = await index.session(source());
  assert.deepEqual(result.files.map((file) => file.path), ["src/a.ts"]);
});

test("unobservable provider is not read", async () => {
  const { read, reads } = journal([toolStart(1, "Read", { file_path: "src/a.ts" })]);
  const touches = new ContextTouches({ read, areas: noAreas });
  const result = await touches.session(source({ provider: "opencode" }));
  assert.deepEqual(result, {
    sessionId: "s1",
    observable: false,
    complete: true,
    graphQueries: 0,
    files: [],
    truncated: false,
  });
  assert.deepEqual(reads, []);
});

test("a session is observable only when its journal holds a recorded tool input", async () => {
  const signal = (seq: number, data: Record<string, unknown>): Event => ({ seq, at: iso(seq), type: "signal", data });
  const index = (events: Event[], pageSize?: number) => new ContextTouches({ read: journal(events, pageSize).read, areas: noAreas, maxReads: 1 });
  const facts = async (events: Event[], provider = "claude", pageSize?: number) => {
    const result = await index(events, pageSize).session(source({ provider }));
    return [result.observable, result.complete, result.files.length];
  };

  // Codex with its hooks off, or a session started with native arguments: the journal holds no signal at all.
  assert.deepEqual(await index([]).session(source({ provider: "codex" })), {
    sessionId: "s1", observable: false, complete: true, graphQueries: 0, files: [], truncated: false,
  });
  // Terminal and screen readings carry no tool inputs, however many there are.
  assert.deepEqual(await facts([signal(1, { kind: "turn-start", source: "screen" }), signal(2, { kind: "prompt-open", source: "osc" })]), [false, true, 0]);
  // A native Codex session sends turn signals over its protocol and never a tool input.
  assert.deepEqual(await facts([signal(1, { kind: "turn-start", source: "protocol" }), signal(2, { kind: "turn-end", source: "protocol" })], "codex"), [false, true, 0]);
  // A hook signal without a tool input is not evidence either: the notify route sends those.
  assert.deepEqual(await facts([signal(1, { kind: "turn-start", source: "hook" }), signal(2, { kind: "turn-end", source: "hook" })], "codex"), [false, true, 0]);
  // A headless run line is a tool start with an empty input and no hook behind it.
  assert.deepEqual(await facts([signal(1, { kind: "tool-start", source: "protocol", tool: "bash", toolUseId: "t1", input: {}, quiet: false })], "codex"), [false, true, 0]);
  // One tool input recorded by a hook is the evidence, even when its path is outside the workspace and is dropped.
  assert.deepEqual(await facts([toolStart(1, "Read", { file_path: "/etc/hosts" })]), [true, true, 0]);
  // While the journal is still being read nothing is known yet, and that reads as a gap, not as an agent that touched nothing.
  assert.deepEqual(await facts([signal(1, { kind: "turn-start", source: "screen" }), toolStart(2, "Read", { file_path: "src/a.ts" })], "claude", 1), [false, false, 0]);
});

test("incremental cursor", async () => {
  const events = [toolStart(1, "Read", { file_path: "src/a.ts" }), toolStart(2, "Edit", { file_path: "src/a.ts" })];
  const reader = journal(events);
  const touches = new ContextTouches({ read: reader.read, areas: noAreas });

  const first = await touches.session(source());
  assert.equal(first.complete, true);
  assert.deepEqual(first.files, [{ path: "src/a.ts", reads: 1, edits: 1, lastAt: iso(2) }]);

  events.push(toolStart(3, "Read", { file_path: "src/a.ts" }));
  const second = await touches.session(source());
  assert.deepEqual(reader.reads, [0, 2]);
  assert.deepEqual(second.files, [{ path: "src/a.ts", reads: 2, edits: 1, lastAt: iso(3) }]);
});

test("read budget on an output-heavy journal", async () => {
  // Each page scans 512 KiB, returns nothing, and reports more.
  const reads: number[] = [];
  const touches = new ContextTouches({
    read: (_sessionId, after) => {
      reads.push(after);
      return { events: [], cursor: after + 500, more: true };
    },
    areas: noAreas,
  });
  const result = await touches.session(source());
  assert.equal(reads.length, 8);
  assert.deepEqual(reads, [0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.files, []);
});

test("reads yield the event loop between calls", async () => {
  let ticks = 0;
  const seenAtRead: number[] = [];
  const touches = new ContextTouches({
    read: (_sessionId, after) => {
      seenAtRead.push(ticks);
      setImmediate(() => { ticks++; });
      return { events: [], cursor: after + 1, more: true };
    },
    areas: noAreas,
  });
  await touches.session(source());
  assert.deepEqual(seenAtRead, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("truncation keeps the newest 300", async () => {
  const events = Array.from({ length: 301 }, (_, i) => toolStart(i + 1, "Read", { file_path: `src/f${i}.ts` }));
  const touches = new ContextTouches({ read: journal(events).read, areas: noAreas });
  const result = await touches.session(source());
  assert.equal(result.files.length, 300);
  assert.equal(result.truncated, true);
  assert.equal(result.files[0].path, "src/f300.ts");
  assert.equal(result.files.at(-1)?.path, "src/f1.ts");
  assert.ok(!result.files.some((file) => file.path === "src/f0.ts"));
});

test("session eviction", async () => {
  const sessions: Record<string, Event[]> = {
    a: [toolStart(1, "Read", { file_path: "src/a.ts" })],
    b: [toolStart(1, "Read", { file_path: "src/b.ts" })],
    c: [toolStart(1, "Read", { file_path: "src/c.ts" })],
  };
  const readers = Object.fromEntries(Object.entries(sessions).map(([id, events]) => [id, journal(events)]));
  const touches = new ContextTouches({
    read: (sessionId, after) => readers[sessionId].read(sessionId, after),
    areas: noAreas,
    maxSessions: 2,
  });
  for (const id of ["a", "b", "c"]) await touches.session(source({ sessionId: id }));

  // "a" was least recently used and is gone, so it is rebuilt from the start.
  const again = await touches.session(source({ sessionId: "a" }));
  assert.deepEqual(readers.a.reads, [0, 0]);
  assert.deepEqual(again.files.map((file) => file.path), ["src/a.ts"]);
  assert.equal(again.files[0].reads, 1);

  // "c" is still indexed and reads only past its cursor.
  await touches.session(source({ sessionId: "c" }));
  assert.deepEqual(readers.c.reads, [0, 1]);
});

test("concurrent calls share one advance", async () => {
  const reader = journal([toolStart(1, "Read", { file_path: "src/a.ts" }), toolStart(2, "Read", { file_path: "src/a.ts" })]);
  const touches = new ContextTouches({ read: reader.read, areas: noAreas });
  const [first, second] = await Promise.all([touches.session(source()), touches.session(source())]);
  assert.equal(reader.reads.length, 1);
  assert.deepEqual(first.files, [{ path: "src/a.ts", reads: 2, edits: 0, lastAt: iso(2) }]);
  assert.deepEqual(second, first);
});

test("a truncated or quoted shell command invents no path", () => {
  const always = () => true;
  // The recorder cut this command; the last word may be the start of a longer file name.
  assert.deepEqual(extractTouches("Bash", { command: "cat src/first.ts src/example.ts … [+20 chars]" }, CWD, always).reads, []);
  // One quoted argument with a space is one word, and it is not a path.
  assert.deepEqual(extractTouches("Bash", { command: 'cat "src/example.ts backup"' }, CWD, always).reads, []);
  assert.deepEqual(extractTouches("Bash", { command: "cat 'src/example.ts backup' src/real.ts" }, CWD, always).reads, ["src/real.ts"]);
  // An escape or an unclosed quote makes the word ambiguous.
  assert.deepEqual(extractTouches("Bash", { command: "cat src/with\\ space.ts" }, CWD, always).reads, []);
  assert.deepEqual(extractTouches("Bash", { command: 'cat "src/open.ts' }, CWD, always).reads, []);
  // What the shell would splice or expand is never read as a path, in whole or in part.
  for (const command of ["cat src/a.ts<(printf x)", "cat $(printf prefix)src/a.ts", "cat `printf prefix`src/a.ts", "cat src/${NAME}.ts", "cat src/*.ts",
    'cat "src/$NAME.ts"', "cat src/a.ts>src/b.ts", "(cat src/a.ts)", "cat {src/a.ts,src/b.ts}"])
    assert.deepEqual(extractTouches("Bash", { command }, CWD, always).reads, [], command);
  // A comment is not part of the command, even with an apostrophe in it.
  assert.deepEqual(extractTouches("Bash", { command: "cat src/a.ts # don't change this\ncat src/b.ts" }, CWD, always).reads.sort(), ["src/a.ts", "src/b.ts"]);
  // Separators end a word; a redirect written as its own word leaves its neighbours whole.
  assert.deepEqual(extractTouches("Bash", { command: "cat src/a.ts|grep x;cat src/b.ts && cat src/c.ts > out.log" }, CWD, always).reads.sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
  // Controls: plain and fully quoted paths are kept, and a cut command still counts its graph query.
  assert.deepEqual(extractTouches("Bash", { command: 'sed -n 1,20p "src/quoted.ts" && cat src/plain.ts' }, CWD, always).reads.sort(), ["src/plain.ts", "src/quoted.ts"]);
  assert.equal(extractTouches("Bash", { command: "graphify query routes --graph out/graph.json … [+9 chars]" }, CWD, always).graphQuery, true);
});

test("concurrent sessions are read a few at a time and never outgrow the index", async () => {
  let reading = 0, peak = 0, largest = 0;
  const touches: ContextTouches = new ContextTouches({
    read: async (_sessionId, after) => {
      reading++; peak = Math.max(peak, reading); largest = Math.max(largest, touches.indexed);
      await new Promise((resolve) => setTimeout(resolve, 5));
      reading--;
      return { events: after === 0 ? [toolStart(1, "Read", { file_path: "src/a.ts" })] : [], cursor: 1, more: false };
    },
    areas: noAreas,
    maxSessions: 3,
    maxConcurrent: 2,
  });
  const ids = Array.from({ length: 9 }, (_, index) => `s${index}`);
  const results = await Promise.all(ids.map((sessionId) => touches.session(source({ sessionId }))));
  assert.equal(peak, 2, "no more than two journals are read at once");
  // Three sessions fit. The other six are told to come back and nothing is allocated or read for them.
  assert.equal(results.filter((result) => result.complete).length, 3);
  assert.deepEqual(results.filter((result) => !result.complete).map((result) => [result.observable, result.files.length]), Array(6).fill([false, 0]));
  assert.equal(largest, 3);
  assert.equal(touches.indexed, 3);
  // Once the three are idle a refused session is admitted in place of the least recently used one.
  const later = await touches.session(source({ sessionId: "s8" }));
  assert.equal(later.complete, true);
  assert.equal(touches.indexed, 3);
});

test("a journal read that throws frees its slot and the session can be read again", async () => {
  let failures = 1, reading = 0;
  const touches = new ContextTouches({
    read: async (_sessionId, after) => {
      reading++;
      try {
        if (failures-- > 0) throw new Error("journal unreadable");
        return { events: after === 0 ? [toolStart(1, "Read", { file_path: "src/a.ts" })] : [], cursor: 1, more: false };
      } finally { reading--; }
    },
    areas: noAreas,
    maxConcurrent: 1,
  });
  await assert.rejects(touches.session(source({ sessionId: "a" })), /journal unreadable/);
  // With one slot, a leaked slot would leave this call waiting forever.
  const [again, other] = await Promise.all([touches.session(source({ sessionId: "a" })), touches.session(source({ sessionId: "b" }))]);
  assert.equal(again.complete, true);
  assert.equal(other.complete, true);
  assert.equal(reading, 0);
});
