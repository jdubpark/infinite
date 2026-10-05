import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";

// Mirror the terminal even while the local editor covers it. Closing the editor
// restores the latest cloud screen, including redraws that arrived meanwhile.
export function draftTerminal() {
  const terminal = new headless.Terminal({ cols: process.stdout.columns || 120, rows: process.stdout.rows || 32, scrollback: 0, allowProposedApi: true });
  const serializer = new serialize.SerializeAddon(); terminal.loadAddon(serializer);
  let draft: { input: PassThrough; editor: ReturnType<typeof createInterface>; lines: string[] } | undefined;
  let savedDraft: string | undefined;
  const redraw = () => process.stdout.write("\x1b[?1049l\x1b[0m\x1b[2J\x1b[H" + serializer.serialize({ scrollback: 0 }));
  return {
    get active() { return Boolean(draft); },
    async output(text: string) {
      await new Promise<void>(resolve => terminal.write(text, resolve));
      if (!draft && !process.stdout.write(text)) await new Promise<void>(resolve => process.stdout.once("drain", resolve));
    },
    resize(cols: number, rows: number) { terminal.resize(cols, rows); },
    async snapshot(ansi: string, cols: number, rows: number) {
      terminal.resize(cols, rows);
      // Cancel any partial escape sequence and restore the snapshot's modes.
      await this.output("\x18" + ansi);
    },
    keep(text: string) { savedDraft = text; },
    open() {
      if (draft || !process.stdin.isTTY || !process.stdout.isTTY) return;
      process.stdout.write("\x1b[?1049h\x1b[0m\x1b[2J\x1b[H\x1b[?25h\x1b[?2004h[Infinite] Local draft — nothing is sent while you type.\r\nEnter: new line · Ctrl+S: insert into native prompt · Esc: cancel\r\nSubmit with Enter in the native terminal after insertion.\r\n\r\n");
      const input = new PassThrough();
      const editor = createInterface({ input, output: process.stdout, terminal: true, prompt: "> " });
      const restored = savedDraft?.split("\n") ?? [""]; savedDraft = undefined;
      const current = restored.pop()!;
      const lines = restored;
      for (const line of lines) process.stdout.write(`> ${line}\r\n`);
      draft = { input, editor, lines };
      editor.on("line", line => { lines.push(line); editor.prompt(); });
      editor.on("SIGINT", () => this.finish(false));
      editor.on("close", () => { if (draft?.editor === editor) this.finish(false); });
      editor.prompt();
      editor.write(current);
    },
    input(data: string) { draft?.input.write(data); },
    pause() {
      if (!draft) return false;
      const text = [...draft.lines, draft.editor.line].join("\n");
      this.finish(false); savedDraft = text; return true;
    },
    finish(insert: boolean): string | undefined {
      if (!draft) return;
      const { editor, input, lines } = draft;
      const text = [...lines, editor.line].join("\n");
      if (insert && (text.length > 32000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text))) {
        process.stdout.write("\r\n[Infinite] Draft must be at most 32,000 characters without terminal control codes.\r\n"); editor.prompt(true); return;
      }
      draft = undefined; editor.close(); input.destroy(); redraw();
      return insert && text.length ? text : undefined;
    },
    dispose() { savedDraft = undefined; if (draft) { const { editor, input } = draft; draft = undefined; editor.close(); input.destroy(); } terminal.dispose(); },
  };
}
