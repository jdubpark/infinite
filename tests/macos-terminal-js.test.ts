import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import headless from "@xterm/headless";
import { eventTerminalDimensions, readTerminalDimensions } from "../apps/web/src/terminal-dimensions.js";

const TERMINAL_JS_PATH = resolve("apps/macos/Sources/InfiniteDesktop/Resources/terminal.js");
const TERMINAL_JS_SOURCE = readFileSync(TERMINAL_JS_PATH, "utf8");

type OpLog =
  | { op: "reset" }
  | { op: "resize"; cols: number; rows: number }
  | { op: "write"; text: string; cols: number; rows: number }
  | { op: "propose" };

interface InfiniteTerminalApi {
  feed(base64: string, reset: boolean, columns?: number, rows?: number): Promise<void>;
  applyFrame(frame: Record<string, unknown>): Promise<void>;
  control(enabled: boolean): void;
  render(enabled: boolean): void;
  follow(enabled: boolean): void;
  focus(): void;
  selection(): string;
  selectAll(): void;
  resize(): void;
}

function mountTerminalJs(initialViewport: { cols: number; rows: number } | undefined = { cols: 60, rows: 18 }) {
  let proposed: { cols: number; rows: number } | undefined = initialViewport;
  const ops: OpLog[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const observers: Array<() => void> = [];
  let createdTerminal: headless.Terminal | undefined;

  class HarnessTerminal {
    private readonly inner: headless.Terminal;
    private readonly dataListeners: Array<(text: string) => void> = [];
    private readonly resizeListeners: Array<(size: { cols: number; rows: number }) => void> = [];
    options: Record<string, unknown>;

    constructor(opts: Record<string, unknown>) {
      this.options = { ...opts };
      this.inner = new headless.Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
      createdTerminal = this.inner;
    }

    get cols() { return this.inner.cols; }
    get rows() { return this.inner.rows; }
    loadAddon() {}
    open() {}
    focus() {}
    getSelection() { return ""; }
    selectAll() {}
    attachCustomKeyEventHandler() {}
    onData(fn: (text: string) => void) { this.dataListeners.push(fn); }
    onResize(fn: (size: { cols: number; rows: number }) => void) { this.resizeListeners.push(fn); }

    reset() {
      ops.push({ op: "reset" });
      this.inner.reset();
    }

    resize(cols: number, rows: number) {
      ops.push({ op: "resize", cols, rows });
      this.inner.resize(cols, rows);
      for (const listener of this.resizeListeners) listener({ cols, rows });
    }

    write(data: Uint8Array | string, callback?: () => void) {
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      ops.push({ op: "write", text, cols: this.inner.cols, rows: this.inner.rows });
      this.inner.write(data, () => callback?.());
    }
  }

  class HarnessFitAddon {
    proposeDimensions() {
      ops.push({ op: "propose" });
      return proposed;
    }
  }

  class HarnessResizeObserver {
    constructor(private readonly callback: () => void) {
      observers.push(callback);
    }
    observe() {}
    disconnect() {}
  }

  const windowObj: Record<string, unknown> = {
    webkit: {
      messageHandlers: {
        terminal: {
          postMessage(value: Record<string, unknown>) {
            posted.push({ ...value });
          },
        },
      },
    },
  };

  const sandbox: Record<string, unknown> = {
    window: windowObj,
    document: {
      visibilityState: "visible",
      addEventListener() {},
      getElementById() { return {}; },
    },
    Terminal: HarnessTerminal,
    FitAddon: { FitAddon: HarnessFitAddon },
    WebglAddon: { WebglAddon: class { onContextLoss() {} dispose() {} } },
    ResizeObserver: HarnessResizeObserver,
    atob: (input: string) => Buffer.from(input, "base64").toString("binary"),
    console: { warn() {} },
    Uint8Array,
    Promise,
    Math,
    Number,
  };

  vm.runInNewContext(TERMINAL_JS_SOURCE, sandbox, { filename: TERMINAL_JS_PATH });
  const api = windowObj.infiniteTerminal as InfiniteTerminalApi;
  assert.ok(api && createdTerminal);

  const lineText = (row: number) => createdTerminal!.buffer.active.getLine(row)?.translateToString(true) ?? "";
  const clearTrace = () => { ops.length = 0; posted.length = 0; };
  const setViewport = (next: { cols: number; rows: number } | undefined) => { proposed = next; };
  const triggerResizeObserver = () => { for (const observer of observers) observer(); };
  const dispose = () => { createdTerminal?.dispose(); };

  return { api, terminal: createdTerminal, ops, posted, lineText, clearTrace, setViewport, triggerResizeObserver, dispose };
}

test("sized open and replay frames without control size xterm to server geometry before writing and never call viewport fit", async () => {
  const h = mountTerminalJs({ cols: 60, rows: 18 });
  try {
    assert.deepEqual(h.posted.at(-1), { type: "ready", cols: 60, rows: 18 });
    h.clearTrace();

    await h.api.applyFrame({ open: { cursor: 0, cols: 120, rows: 32 }, cursor: 0, cols: 120, rows: 32 });
    const wideLine = "A".repeat(100);
    await h.api.applyFrame({
      events: [{ seq: 3, type: "output", data: { text: `${wideLine}\r\nSECOND_ROW` } }],
      cursor: 3,
      cols: 120,
      rows: 32,
    });

    assert.equal(h.ops.filter(entry => entry.op === "propose").length, 0, "sized replay without control never guesses viewport dimensions");
    const resizeIndex = h.ops.findIndex(entry => entry.op === "resize" && entry.cols === 120 && entry.rows === 32);
    const writeIndex = h.ops.findIndex(entry => entry.op === "write" && entry.text.includes(wideLine));
    assert.ok(resizeIndex >= 0 && writeIndex > resizeIndex, "server geometry is applied strictly before writing replayed bytes");
    assert.equal(h.terminal.cols, 120);
    assert.equal(h.terminal.rows, 32);
    assert.equal(h.lineText(0), wideLine, "100-column TUI row stays unwrapped on one line at 120 cols");
    assert.equal(h.lineText(1), "SECOND_ROW");
    assert.deepEqual(h.posted, [], "server-driven geometry adoption does not echo a resize command back to Swift");

    h.setViewport({ cols: 48, rows: 14 });
    h.triggerResizeObserver();
    h.api.resize();
    assert.equal(h.ops.filter(entry => entry.op === "propose").length, 0);
    assert.equal(h.terminal.cols, 120);
    assert.equal(h.terminal.rows, 32);
  } finally {
    h.dispose();
  }
});

test("sized feed without control preserves server geometry before write, and follow mode resists stale cached dimensions", async () => {
  const h = mountTerminalJs({ cols: 60, rows: 18 });
  try {
    h.clearTrace();
    const wide = "B".repeat(105) + "\r\nTAIL";
    await h.api.feed(Buffer.from(wide, "utf8").toString("base64"), true, 120, 32);

    assert.equal(h.ops.filter(entry => entry.op === "propose").length, 0);
    const resizeIndex = h.ops.findIndex(entry => entry.op === "resize" && entry.cols === 120 && entry.rows === 32);
    const writeIndex = h.ops.findIndex(entry => entry.op === "write");
    assert.ok(resizeIndex >= 0 && writeIndex > resizeIndex);
    assert.equal(h.lineText(0), "B".repeat(105));
    assert.equal(h.lineText(1), "TAIL");

    h.api.follow(true);
    assert.equal(h.terminal.cols, 60);
    assert.equal(h.terminal.rows, 18);
    assert.deepEqual(h.posted, [{ type: "resize", cols: 60, rows: 18 }]);

    h.clearTrace();
    await h.api.feed(Buffer.from("\r\nLIVE", "utf8").toString("base64"), false, 120, 32);
    assert.equal(h.terminal.cols, 60, "cached dimensions from initial reset do not snap controlled viewport back");
    assert.equal(h.terminal.rows, 18);
  } finally {
    h.dispose();
  }
});

test("subsequent resize lifecycle events, non-reset sized feeds, and snapshots update geometry in strict write order", async () => {
  const h = mountTerminalJs({ cols: 60, rows: 18 });
  try {
    h.clearTrace();
    await h.api.applyFrame({ open: { cursor: 0, cols: 120, rows: 32 }, cursor: 0, cols: 120, rows: 32 });
    await h.api.applyFrame({
      events: [
        { seq: 3, type: "output", data: { text: "AT_120\r\n" } },
        { seq: 4, type: "lifecycle", data: { event: "resize", cols: 88, rows: 26 } },
        { seq: 5, type: "output", data: { text: "AT_88\r\n" } },
      ],
      cursor: 5,
    });

    const writes = h.ops.filter((entry): entry is Extract<OpLog, { op: "write" }> => entry.op === "write");
    assert.deepEqual(
      writes.map(entry => ({ text: entry.text, cols: entry.cols, rows: entry.rows })),
      [
        { text: "AT_120\r\n", cols: 120, rows: 32 },
        { text: "AT_88\r\n", cols: 88, rows: 26 },
      ],
    );
    assert.equal(h.terminal.cols, 88);
    assert.equal(h.terminal.rows, 26);

    await h.api.feed(Buffer.from("AT_96\r\n", "utf8").toString("base64"), false, 96, 28);
    assert.equal(h.terminal.cols, 96);
    assert.equal(h.terminal.rows, 28);

    await h.api.applyFrame({
      open: { cursor: 10, cols: 104, rows: 40 },
      snapshot: { ansi: "\x1bcSNAPSHOT_104", seq: 10, cols: 104, rows: 40, capturedAt: "2026-11-26T00:00:00.000Z" },
      cursor: 10,
      cols: 104,
      rows: 40,
    });
    assert.equal(h.terminal.cols, 104);
    assert.equal(h.terminal.rows, 40);
    assert.equal(h.lineText(0), "SNAPSHOT_104");
    assert.equal(h.ops.filter(entry => entry.op === "propose").length, 0);
  } finally {
    h.dispose();
  }
});

test("legacy unsized replay frames fall back gracefully to viewport fit even when viewport size is unavailable", async () => {
  const h = mountTerminalJs({ cols: 72, rows: 22 });
  try {
    await h.api.applyFrame({ open: { cursor: 0, cols: 132, rows: 43 }, cursor: 0, cols: 132, rows: 43 });
    assert.equal(h.terminal.cols, 132);
    assert.equal(h.terminal.rows, 43);

    h.clearTrace();
    await h.api.applyFrame({ open: { cursor: 0 }, cursor: 0 });
    await h.api.applyFrame({ events: [{ seq: 1, type: "output", data: { text: "LEGACY_LINE\r\n" } }], cursor: 1 });
    assert.ok(h.ops.some(entry => entry.op === "propose"), "legacy unsized open falls back to viewport fit");
    assert.equal(h.terminal.cols, 72);
    assert.equal(h.terminal.rows, 22);
    assert.equal(h.lineText(0), "LEGACY_LINE");

    h.setViewport(undefined);
    h.clearTrace();
    await h.api.feed(Buffer.from("NO_VIEWPORT\r\n", "utf8").toString("base64"), true, 0, 0);
    assert.equal(h.lineText(0), "NO_VIEWPORT");

    await h.api.applyFrame({ replay: { text: "RAW_LEGACY_REPLAY\r\n" } });
    assert.equal(h.lineText(0), "RAW_LEGACY_REPLAY");
  } finally {
    h.dispose();
  }
});

test("macOS TerminalPipe buffered history replay and subsequent non-reset resize feed preserve server geometry across control handoff", async () => {
  const h = mountTerminalJs({ cols: 64, rows: 20 });
  try {
    h.clearTrace();
    const bufferedHistory = "H".repeat(108) + "\r\nSECOND_HISTORY";
    await h.api.feed(Buffer.from(bufferedHistory, "utf8").toString("base64"), true, 120, 32);
    assert.equal(h.terminal.cols, 120);
    assert.equal(h.terminal.rows, 32);
    assert.equal(h.lineText(0), "H".repeat(108));

    await h.api.feed(Buffer.from("\r\nLIVE_SAME_SIZE", "utf8").toString("base64"), false, 120, 32);
    assert.equal(h.terminal.cols, 120);
    assert.equal(h.terminal.rows, 32);

    const postResize = "\r\n" + "R".repeat(86);
    await h.api.feed(Buffer.from(postResize, "utf8").toString("base64"), false, 92, 27);
    assert.equal(h.terminal.cols, 92);
    assert.equal(h.terminal.rows, 27);
    const writes = h.ops.filter((entry): entry is Extract<OpLog, { op: "write" }> => entry.op === "write");
    const lastWrite = writes.at(-1)!;
    assert.deepEqual([lastWrite.cols, lastWrite.rows], [92, 27]);
    assert.equal(h.ops.filter(entry => entry.op === "propose").length, 0);

    h.api.follow(true);
    assert.equal(h.terminal.cols, 64);
    assert.equal(h.terminal.rows, 20);
    assert.deepEqual(h.posted, [{ type: "resize", cols: 64, rows: 20 }]);

    h.clearTrace();
    h.api.follow(false);
    h.setViewport({ cols: 50, rows: 15 });
    h.triggerResizeObserver();
    assert.equal(h.ops.filter(entry => entry.op === "propose").length, 0);
    assert.equal(h.terminal.cols, 64);
    assert.equal(h.terminal.rows, 20);
  } finally {
    h.dispose();
  }
});

test("web TerminalView extracts authoritative server dimensions from lifecycle and output events", () => {
  assert.deepEqual(
    eventTerminalDimensions({ seq: 2, at: "2026-11-26T00:00:00.000Z", type: "lifecycle", data: { status: "running", pid: 42, cols: 120, rows: 32 } }),
    { cols: 120, rows: 32 },
  );
  assert.deepEqual(
    eventTerminalDimensions({ seq: 4, at: "2026-11-26T00:00:00.000Z", type: "lifecycle", data: { event: "resize", cols: 88, rows: 26 } }),
    { cols: 88, rows: 26 },
  );
  assert.deepEqual(
    eventTerminalDimensions({ seq: 5, at: "2026-11-26T00:00:00.000Z", type: "output", data: { text: "snap", snapshot: true, cols: 140, rows: 45 } }),
    { cols: 140, rows: 45 },
  );
  assert.equal(
    eventTerminalDimensions({ seq: 6, at: "2026-11-26T00:00:00.000Z", type: "output", data: { text: "plain" } }),
    undefined,
  );
  assert.equal(readTerminalDimensions({ cols: 0, rows: 24 }), undefined);
  assert.equal(readTerminalDimensions({ cols: 80.5, rows: 24 }), undefined);
});
