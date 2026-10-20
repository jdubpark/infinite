// The web client's real conversation panel, polling a stand-in host. tests/web-polling.test.ts counts its requests through `window.polling`
// and, while `hold` is set, answers each request only when the test resolves it; while `fail` is set, each request fails.
import { createRoot } from "react-dom/client";
import { ApiContext, type Api } from "../../apps/web/src/api";
import type { MessagesPage } from "../../apps/web/src/api";
import { Conversation } from "../../apps/web/src/session-extras";

const empty: MessagesPage = { messages: [], cursor: 0, more: false };
const control = { requests: 0, hold: false, fail: false, pending: [] as ((page: MessagesPage) => void)[] };
Object.assign(window, { polling: control });

const host = (async (path: string) => {
  if (!path.startsWith("/sessions/s1/messages")) throw new Error(`Unexpected request: ${path}`);
  control.requests++;
  if (control.fail) throw new Error("The host is unreachable.");
  if (control.hold) return new Promise<MessagesPage>(resolve => control.pending.push(resolve));
  return empty;
}) as unknown as Api;

createRoot(document.getElementById("root")!).render(<ApiContext.Provider value={host}><Conversation id="s1" /></ApiContext.Provider>);
