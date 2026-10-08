import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { randomUUID } from "node:crypto";
import type { localDraftStore, LocalDraft } from "./client-draft-store.js";

// Mirror the terminal even while the local editor covers it. Closing the editor
// restores the latest cloud screen, including redraws that arrived meanwhile.
export function draftTerminal(store: ReturnType<typeof localDraftStore>) {
  const terminal = new headless.Terminal({ cols: process.stdout.columns || 120, rows: process.stdout.rows || 32, scrollback: 0, allowProposedApi: true });
  const serializer = new serialize.SerializeAddon(); terminal.loadAddon(serializer);
  let draft: { input: PassThrough; editor: ReturnType<typeof createInterface>; lines: string[] } | undefined;
  let savedDraft: LocalDraft | undefined = store.restore();
  const text = () => draft ? [...draft.lines, draft.editor.line].join("\n") : savedDraft?.text ?? "";
  const save = (immediately = false) => {
    savedDraft = { ...savedDraft, text: text(), state: savedDraft?.state ?? "draft" };
    return store.save(savedDraft, immediately);
  };
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
    inserted() { if (store.clear()) savedDraft = undefined; },
    refused() { if (savedDraft) { savedDraft = { text: savedDraft.text, state: "draft" }; store.save(savedDraft, true); } },
    discard() {
      if (!store.clear()) return;
      savedDraft = undefined;
      if (draft) { const { editor, input } = draft; draft = undefined; editor.close(); input.destroy(); redraw(); }
    },
    reviewed() {
      if (savedDraft?.state !== "uncertain") return;
      savedDraft = { text: savedDraft.text, state: "draft" }; store.save(savedDraft, true);
      process.stdout.write("\r\n[Infinite] Marked as unsent after your review. Ctrl+S inserts it; this may duplicate an earlier insertion.\r\n");
      draft?.editor.prompt(true);
    },
    open() {
      if (draft || !process.stdin.isTTY || !process.stdout.isTTY) return;
      savedDraft ??= store.restore();
      process.stdout.write("\x1b[?1049h\x1b[0m\x1b[2J\x1b[H\x1b[?25h\x1b[?2004h[Infinite] Local draft — nothing is sent while you type.\r\nEnter: new line · Ctrl+S: insert · Esc: keep and close · Ctrl+X: discard\r\nDrafts are saved encrypted on this laptop. Submit with Enter in the native terminal.\r\n\r\n");
      if (savedDraft?.state === "uncertain") process.stdout.write("[Infinite] Previous insertion unconfirmed. Esc to inspect the native prompt first.\r\nEditing and insertion are blocked until Ctrl+R marks this as unsent after your review.\r\n\r\n");
      const input = new PassThrough();
      const editor = createInterface({ input, output: process.stdout, terminal: true, prompt: "> " });
      const restored = savedDraft?.text.split("\n") ?? [""];
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
    input(data: string) {
      if (savedDraft?.state === "uncertain") return;
      draft?.input.write(data); if (draft) save();
    },
    pause() {
      if (!draft) return false;
      this.finish(false); return true;
    },
    finish(insert: boolean): { text: string; requestId: string } | undefined {
      if (!draft) return;
      if (insert && savedDraft?.state === "uncertain") {
        process.stdout.write("\r\n[Infinite] Insertion blocked: inspect the native prompt, then Ctrl+R only if this draft still needs inserting.\r\n"); return;
      }
      const { editor, input, lines } = draft;
      const text = [...lines, editor.line].join("\n");
      if (insert && (text.length > 32000 || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text))) {
        process.stdout.write("\r\n[Infinite] Draft must be at most 32,000 characters without terminal control codes.\r\n"); editor.prompt(true); return;
      }
      const requestId = randomUUID();
      if (insert && text) {
        savedDraft = { text, state: "uncertain", requestId };
        // Persist the uncertain state before any bytes can reach the host.
        if (!store.save(savedDraft, true)) return;
      } else if (!save(true)) return;
      draft = undefined; editor.close(); input.destroy(); redraw();
      return insert && text.length ? { text, requestId } : undefined;
    },
    dispose() { if (draft) { save(true); const { editor, input } = draft; draft = undefined; editor.close(); input.destroy(); } store.close(); terminal.dispose(); },
  };
}
