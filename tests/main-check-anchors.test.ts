import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorOf, earlierFor, MAX_ANCHORED, mainCheckAnchorSchema, readAnchor, type MainCheckAnchor } from "../packages/host/src/main-check-anchors.js";
import { anchorDirectory, defaultMainCheckPorts, recordDirectory } from "../packages/host/src/main-check-ports.js";
import { emptyRecord } from "../packages/host/src/main-check-state.js";
import type { CensusFinding } from "../packages/host/src/process-census.js";
import type { Config } from "../packages/host/src/types.js";

const KEY = Buffer.alloc(32, 9);
const COPY = "alpha-2026-11-25-main-check-0a1b2c3d";
const ANCHOR: MainCheckAnchor = { version: 1, boot: "boot-1", processes: [{ pid: 40, start: "4000" }] };

function sealedPorts() {
  const base = mkdtempSync(join(tmpdir(), "main-check-anchors-"));
  const config = { stateDir: join(base, "state") } as unknown as Config;
  const ports = defaultMainCheckPorts({ config, key: KEY, halt: { check: () => ({ state: "clear" }) }, hostLoad: { held: () => undefined } });
  return { base, config, ports };
}

test("an anchor is sealed per copy beside the records, which an earlier release's record listing never shows (INF-403)", () => {
  const { base, config, ports } = sealedPorts();
  try {
    assert.deepEqual(ports.anchors.list(), []);
    ports.anchors.write("alpha", COPY, ANCHOR);
    ports.records.write("alpha", emptyRecord());
    assert.deepEqual(ports.anchors.list(), [COPY]);
    assert.deepEqual(ports.records.list(), ["alpha"], "the record listing reads only its own directory");
    assert.deepEqual(readdirSync(recordDirectory(config)), ["alpha.sealed"]);
    assert.deepEqual(readdirSync(anchorDirectory(config)), [`${COPY}.sealed`]);
    assert.deepEqual(readAnchor(ports.anchors, "alpha", COPY), ANCHOR);
    assert.equal(readAnchor(ports.anchors, "beta", COPY), undefined, "an anchor sealed for another project does not open");
    assert.equal(readAnchor(ports.anchors, "alpha", "alpha-2026-11-25-main-check-ffffffff"), undefined, "no anchor for another copy");
    ports.anchors.remove(COPY);
    ports.anchors.remove(COPY);
    assert.deepEqual(ports.anchors.list(), []);
    assert.equal(readAnchor(ports.anchors, "alpha", COPY), undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the anchor schema is strict: one changed field of a valid anchor is refused (INF-403)", () => {
  assert.equal(mainCheckAnchorSchema.safeParse(ANCHOR).success, true);
  const item = ANCHOR.processes[0]!;
  const negatives: [string, unknown][] = [
    ["another version", { ...ANCHOR, version: 2 }],
    ["an unknown field", { ...ANCHOR, recording: true }],
    ["an empty boot", { ...ANCHOR, boot: "" }],
    ["no process", { ...ANCHOR, processes: [] }],
    ["more processes than the limit", { ...ANCHOR, processes: Array.from({ length: MAX_ANCHORED + 1 }, (_, index) => ({ pid: index + 1, start: "1" })) }],
    ["pid zero", { ...ANCHOR, processes: [{ ...item, pid: 0 }] }],
    ["a fractional pid", { ...ANCHOR, processes: [{ ...item, pid: 1.5 }] }],
    ["an empty start token", { ...ANCHOR, processes: [{ ...item, start: "" }] }],
    ["an unknown process field", { ...ANCHOR, processes: [{ ...item, reason: "unreadable" }] }],
  ];
  for (const [name, value] of negatives) assert.equal(mainCheckAnchorSchema.safeParse(value).success, false, name);
  const { base, ports } = sealedPorts();
  try {
    ports.anchors.write("alpha", COPY, { ...ANCHOR, version: 2 } as unknown as MainCheckAnchor);
    assert.equal(readAnchor(ports.anchors, "alpha", COPY), undefined, "a stored anchor the schema refuses is no anchor");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an anchor takes the start token of each process the census could not inspect, at most 256 (INF-403)", async () => {
  const unreadable = (pid: number): CensusFinding => ({ pid, reason: "unreadable" });
  const token = async (pid: number) => pid === 13 ? undefined : pid === 14 ? Promise.reject(new Error("EIO")) : `t${pid}`;
  const findings = [unreadable(11), { pid: 12, reason: "working-directory" } as CensusFinding, unreadable(13), unreadable(14), unreadable(15)];
  assert.deepEqual(await anchorOf("boot-1", { ok: true, findings }, token), { version: 1, boot: "boot-1", processes: [{ pid: 11, start: "t11" }, { pid: 15, start: "t15" }] });
  assert.equal(await anchorOf("boot-1", { ok: true, findings: [] }, token), undefined);
  assert.equal(await anchorOf("boot-1", { ok: true, findings: [unreadable(13)] }, token), undefined);
  assert.equal(await anchorOf("boot-1", { ok: false, problem: "census wrapper missing" }, token), undefined);
  const many = Array.from({ length: 300 }, (_, index) => unreadable(index + 100));
  const cut = await anchorOf("boot-1", { ok: true, findings: many }, token);
  assert.equal(cut?.processes.length, MAX_ANCHORED);
  assert.deepEqual(cut?.processes.at(-1), { pid: 355, start: "t355" }, "the first 256 are kept");
  assert.equal(mainCheckAnchorSchema.safeParse(cut).success, true);
});

test("an anchor excuses only on the boot it was taken; after a boot change Linux excuses every unreadable process and macOS none (INF-403)", () => {
  const positive = { entry: "boot-1", current: "boot-1", platform: "linux" as NodeJS.Platform, anchor: ANCHOR as MainCheckAnchor | undefined };
  const decide = (fixture: typeof positive) => earlierFor(fixture.entry, fixture.current, fixture.platform, fixture.anchor);
  assert.deepEqual(decide(positive), ANCHOR.processes);
  assert.deepEqual(decide({ ...positive, platform: "darwin" }), ANCHOR.processes, "on one boot the platform does not matter");
  assert.equal(decide({ ...positive, anchor: undefined }), undefined, "no anchor");
  assert.equal(decide({ ...positive, anchor: { ...ANCHOR, boot: "boot-0" } }), undefined, "an anchor of another boot");
  assert.equal(decide({ ...positive, current: "boot-2" }), "all", "the host booted again since the entry was recorded (Linux)");
  assert.equal(decide({ ...positive, current: "boot-2", platform: "darwin" }), undefined, "a changed boot id on macOS keeps waiting");
});
