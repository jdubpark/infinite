import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, readEvents } from "../packages/host/src/vault.js";

test("encrypted replay crosses segment boundaries and rejects wrong keys and record substitution", () => {
  const directory = mkdtempSync(join(tmpdir(), "inf-vault-"));
  const key = randomBytes(32);
  try {
    const journal = new Journal(directory, key, "session-a");
    for (let i = 0; i < 260; i++)
      journal.append("output", { text: `private record ${i}` });
    const page = readEvents(directory, key, "session-a", 254, 4);
    assert.deepEqual(
      page.events.map((e) => e.data.text),
      [
        "private record 254",
        "private record 255",
        "private record 256",
        "private record 257",
      ],
    );
    assert.equal(page.cursor, 258);
    assert.equal(page.more, true);
    assert.throws(() => readEvents(directory, randomBytes(32), "session-a"));
    assert.throws(() => readEvents(directory, key, "different-session"));
    const file = join(directory, "0000000000.journal");
    const lines = readFileSync(file, "utf8").split("\n");
    [lines[0], lines[1]] = [lines[1], lines[0]];
    writeFileSync(file, lines.join("\n"));
    assert.throws(() => readEvents(directory, key, "session-a"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readEvents filters by type while advancing the cursor past skipped records", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-vault-"));
  const key = randomBytes(32);
  try {
    const journal = new Journal(join(dir, "events"), key, "s1");
    journal.append("output", { text: "a" });
    journal.append("signal", {
      kind: "turn-start",
      source: "hook",
      provider: "demo",
    });
    journal.append("output", { text: "b" });
    journal.append("lifecycle", { status: "exited" });
    const types = new Set(["signal", "lifecycle"]);
    const page = readEvents(join(dir, "events"), key, "s1", 0, 10, types);
    assert.deepEqual(
      page.events.map((e) => e.seq),
      [2, 4],
    );
    assert.equal(page.cursor, 4);
    assert.equal(page.more, false);
    const first = readEvents(join(dir, "events"), key, "s1", 0, 1, types);
    assert.deepEqual(
      first.events.map((e) => e.seq),
      [2],
    );
    assert.equal(first.cursor, 2);
    assert.equal(first.more, true);
    const rest = readEvents(
      join(dir, "events"),
      key,
      "s1",
      first.cursor,
      10,
      types,
    );
    assert.deepEqual(
      rest.events.map((e) => e.seq),
      [4],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
