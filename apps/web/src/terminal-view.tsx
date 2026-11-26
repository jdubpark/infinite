import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useApi, type LogEvent } from "./api";
import { eventTerminalDimensions, readTerminalDimensions, type TerminalDimensions } from "./terminal-dimensions";

export function TerminalView({
  id,
  readOnly,
  terminalSize,
}: {
  id: string;
  readOnly: boolean;
  terminalSize?: TerminalDimensions;
}) {
  const api = useApi();
  const viewport = useRef<HTMLDivElement>(null);
  const element = useRef<HTMLDivElement>(null);
  const fallbackSize = useRef(terminalSize);
  fallbackSize.current = terminalSize;
  const [error, setError] = useState("");
  const [serverSized, setServerSized] = useState(false);
  useEffect(() => {
    setServerSized(false);
    const terminal = new Terminal({
      convertEol: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      scrollback: 10000,
      theme: {
        background: "#202923",
        foreground: "#e4e9de",
        cursor: "#e4e9de",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current!);
    let pinned = false;
    const fitViewport = () => {
      if (!pinned) fit.fit();
    };
    const applyServerSize = (size: TerminalDimensions) => {
      pinned = true;
      setServerSized(true);
      if (terminal.cols !== size.cols || terminal.rows !== size.rows) {
        terminal.resize(size.cols, size.rows);
      }
    };
    fitViewport();
    const observer = new ResizeObserver(fitViewport);
    observer.observe(viewport.current!);
    let active = true,
      cursor = 0,
      retry = 1800,
      generation = 0,
      consuming = false,
      repoll = false,
      inFlight: number | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const isHidden = () => document.visibilityState === "hidden";
    const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve));
    const poll = async () => {
      clearTimeout(timer);
      if (!active || consuming || inFlight === generation || isHidden()) return;
      const started = generation;
      const current = () => active && started === generation;
      inFlight = started;
      let interrupted = false;
      try {
        const page = await api<{
          events: LogEvent[];
          cursor: number;
          more: boolean;
        }>(`/sessions/${id}/events?after=${cursor}`);
        if (!current() || isHidden()) return;
        consuming = true;
        for (const event of page.events) {
          if (!active || isHidden()) {
            interrupted = true;
            break;
          }
          const size = eventTerminalDimensions(event);
          if (size) applyServerSize(size);
          if (event.type === "output") {
            if (!pinned) {
              const fallback = readTerminalDimensions(fallbackSize.current);
              if (fallback) applyServerSize(fallback);
            }
            cursor = Math.max(cursor, event.seq);
            await write(String(event.data.text));
            if (!active || !current() || isHidden()) {
              interrupted = true;
              break;
            }
          } else {
            cursor = Math.max(cursor, event.seq);
          }
        }
        if (!interrupted) {
          cursor = Math.max(cursor, page.cursor);
          setError("");
          retry = 1800;
          if (active && current() && !isHidden()) {
            timer = setTimeout(poll, page.more ? 0 : 800);
          }
        }
      } catch {
        if (current()) {
          setError("Waiting for the host. Recorded output will resume here.");
          timer = setTimeout(poll, retry);
          retry = Math.min(retry * 2, 15000);
        }
      } finally {
        consuming = false;
        if (inFlight === started) inFlight = undefined;
        if (repoll) {
          repoll = false;
          if (active && !isHidden()) void poll();
        }
      }
    };
    const resume = () => {
      generation++;
      if (consuming) {
        repoll = true;
        return;
      }
      void poll();
    };
    const retryNow = () => {
      if (consuming) {
        repoll = true;
        return;
      }
      if (inFlight === undefined) void poll();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", retryNow);
    window.addEventListener("focus", retryNow);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", retryNow);
      window.removeEventListener("focus", retryNow);
      observer.disconnect();
      terminal.dispose();
    };
  }, [id]);
  return (
    <div className="terminal-shell">
      <div className="terminal-caption">
        {readOnly ? "Recorded terminal · read-only" : "Recorded terminal · use the composer to send input"}
      </div>
      <div
        className={serverSized ? "terminal is-server-sized" : "terminal"}
        data-server-sized={serverSized ? "true" : "false"}
        ref={viewport}
      >
        <div className="terminal-canvas" ref={element} />
      </div>
      {error && (
        <p className="terminal-error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
