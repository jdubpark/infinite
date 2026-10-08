import { createHash, hkdfSync, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { unseal, writeSealed } from "./vault.js";

export type LocalDraft = { text: string; state: "draft" | "uncertain"; requestId?: string };
type StoredDraft = LocalDraft & { pid: number; updatedAt: number };
const validText = (text: unknown): text is string => typeof text === "string" && text.length <= 32000 && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text);
const alive = (pid: number) => {
  if (pid === 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};

// Every client owns a separate file. An active editor cannot overwrite another
// client's draft, and recovering a crashed client never dispatches its input.
export function localDraftStore(configFile: string, identity: { origin: string; token: string; sessionId: string; projectId: string; runtimeId?: string }, report: (message: string) => void) {
  const scope = JSON.stringify(["cli-draft-v1", identity.origin, identity.sessionId, identity.projectId, identity.runtimeId ?? null]);
  const key = Buffer.from(hkdfSync("sha256", identity.token, scope, "infinite-local-draft", 32));
  const bucket = createHash("sha256").update(key).digest("hex");
  const parent = join(dirname(configFile), "drafts"), directory = join(parent, bucket);
  const file = join(directory, `${randomUUID()}.sealed`);
  let recovered: string | undefined, value: LocalDraft | undefined, timer: ReturnType<typeof setTimeout> | undefined, warned = false;
  const failed = () => { if (!warned) { warned = true; report("Local draft recovery is unavailable. Keep this editor open or copy the text before leaving. Nothing was sent."); } return false; };
  const privateDirectory = (path: string) => {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe draft directory");
  };
  const remove = (path: string | undefined) => { if (path) try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
  const flush = (pid = process.pid) => {
    clearTimeout(timer); timer = undefined;
    try {
      if (value?.text) {
        privateDirectory(parent); privateDirectory(directory);
        writeSealed(file, key, scope, { ...value, pid, updatedAt: Date.now() } satisfies StoredDraft);
      } else remove(file);
      // Only a dead/closed writer is eligible for recovery. Its original is
      // removed after the new copy is durable, never before.
      remove(recovered); recovered = undefined; warned = false; return true;
    } catch { return failed(); }
  };
  return {
    restore(): LocalDraft | undefined {
      if (value) return value;
      try {
        let files: string[];
        try { files = readdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        privateDirectory(parent); privateDirectory(directory);
        if (files.length > 256) throw new Error("Too many local drafts");
        const candidates: { path: string; value: StoredDraft }[] = [];
        for (const name of files) {
          if (!/^[a-f0-9-]{36}\.sealed$/.test(name)) continue;
          const path = join(directory, name), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > 512 * 1024 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe draft record");
            const draft = unseal<StoredDraft>(key, scope, readFileSync(fd, "utf8"));
            if (!validText(draft.text) || !["draft", "uncertain"].includes(draft.state) || !Number.isSafeInteger(draft.pid) || draft.pid < 0 || !Number.isFinite(draft.updatedAt) || (draft.state === "uncertain" && !/^[a-f0-9-]{36}$/.test(draft.requestId ?? ""))) throw new Error("Invalid draft record");
            if (draft.text && !alive(draft.pid)) candidates.push({ path, value: draft });
          } finally { closeSync(fd); }
        }
        const selected = candidates.sort((a, b) => b.value.updatedAt - a.value.updatedAt)[0];
        if (selected) {
          recovered = selected.path; value = selected.value;
          report(selected.value.state === "uncertain" ? "A previous draft insertion is unconfirmed. Ctrl+E reviews it; it will not be sent again automatically." : "Recovered an unsent local draft. Ctrl+E opens it; nothing has been sent.");
          if (candidates.length > 1) report("Other recovered drafts remain saved. Reopen the editor after inserting or discarding this draft to review the next one.");
        }
        return value;
      } catch { failed(); return; }
    },
    save(next: LocalDraft, immediately = false) {
      if (!validText(next.text)) return failed();
      value = next;
      if (immediately) return flush();
      if (!timer) { timer = setTimeout(flush, 200); timer.unref(); }
      return true;
    },
    clear() { value = undefined; return flush(); },
    close() { return flush(0); },
  };
}
