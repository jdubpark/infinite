import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { ApiContext, type Api, type LogEvent } from "../../apps/web/src/api";
import { TerminalView } from "../../apps/web/src/terminal-view";

interface EventsPage {
  events: LogEvent[];
  cursor: number;
  more: boolean;
}

interface HarnessControl {
  pages: Record<number, EventsPage>;
  requests: string[];
  writes: string[];
  holdWriteText: string | null;
  releaseWrite: (() => void) | null;
  writeHeld: boolean;
  holdFetchCount: number;
  pendingFetches: Array<() => void>;
  terminalCols: () => number;
  terminalRows: () => number;
  terminalLines: () => string[];
}

let activeTerminal: Terminal | undefined;
const originalWrite = Terminal.prototype.write;
const control: HarnessControl = {
  pages: {},
  requests: [],
  writes: [],
  holdWriteText: null,
  releaseWrite: null,
  writeHeld: false,
  holdFetchCount: 0,
  pendingFetches: [],
  terminalCols: () => activeTerminal?.cols ?? 0,
  terminalRows: () => activeTerminal?.rows ?? 0,
  terminalLines: () => {
    if (!activeTerminal) return [];
    const buf = activeTerminal.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const text = buf.getLine(i)?.translateToString(true) ?? "";
      if (text) out.push(text);
    }
    return out;
  },
};

Terminal.prototype.write = function (this: Terminal, data: string | Uint8Array, callback?: () => void) {
  activeTerminal = this;
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  control.writes.push(text);
  if (control.holdWriteText !== null && text.includes(control.holdWriteText)) {
    control.holdWriteText = null;
    return originalWrite.call(this, data, () => {
      control.releaseWrite = () => {
        control.releaseWrite = null;
        control.writeHeld = false;
        callback?.();
      };
      control.writeHeld = true;
    });
  }
  return originalWrite.call(this, data, callback);
};

const init = (window as unknown as { terminalViewInit?: { pages: Record<number, EventsPage>; holdWriteText?: string; holdFetchCount?: number } }).terminalViewInit;
if (init) {
  control.pages = init.pages;
  control.holdWriteText = init.holdWriteText ?? null;
  control.holdFetchCount = init.holdFetchCount ?? 0;
}
Object.assign(window, { terminalViewHarness: control });

const host = (async (path: string) => {
  control.requests.push(path);
  const after = Number(new URL(path, "http://127.0.0.1").searchParams.get("after") ?? "0");
  const page = control.pages[after] ?? { events: [], cursor: after, more: false };
  if (control.holdFetchCount > 0) {
    control.holdFetchCount--;
    await new Promise<void>(resolve => control.pendingFetches.push(resolve));
  }
  return page;
}) as unknown as Api;

createRoot(document.getElementById("root")!).render(
  <div style={{ width: "340px", maxWidth: "340px" }}>
    <ApiContext.Provider value={host}>
      <TerminalView id="s1" readOnly={true} />
    </ApiContext.Provider>
  </div>,
);
