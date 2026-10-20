import { useEffect, useRef, useState } from "react";
import type { Prompt } from "@infinite/attention";
import { RefreshCw } from "lucide-react";
import { ApiError, isControlRefusal, isMissionManaged, useApi, type ChatMessage, type MessagesPage, type ProjectFile, type Session } from "./api";
import { useMachines } from "./machines";
import { lifecycles } from "./requests";

export function Conversation({ id }: { id: string }) {
  const api = useApi();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [note, setNote] = useState("Loading conversation…");
  const [source, setSource] = useState("");
  const [stale, setStale] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true, cursor: string | number = "";
    let timer: ReturnType<typeof setTimeout>;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;
    setMessages([]);
    setSource("");
    setNote("Loading conversation…");
    setStale(false);
    setLoaded(false);
    const collected = new Map<string, ChatMessage>();
    // Hiding the tab starts a new generation: a reply to an earlier read is dropped, and returning reads again at once.
    let generation = 0, inFlight: number | undefined;
    async function poll() {
      clearTimeout(timer);
      if (!active || inFlight === generation || document.visibilityState === "hidden") return;
      const started = generation;
      const current = () => active && started === generation;
      inFlight = started;
      try {
        const page = await api<MessagesPage>(`/sessions/${id}/messages?limit=100${cursor === "" ? "" : `&after=${encodeURIComponent(cursor)}`}`);
        if (!current()) return;
        setLoaded(true);
        clearTimeout(staleTimer);
        staleTimer = undefined;
        setStale(false);
        // An empty page keeps the current array, so it does not re-render the same messages every poll.
        if (page.messages.length) {
          for (const message of page.messages) collected.set(message.id, message);
          while (collected.size > 500) collected.delete(collected.keys().next().value!);
          setMessages([...collected.values()]);
        }
        cursor = page.cursor; setSource(page.source ?? "");
        setNote(collected.size ? "" : "No structured messages are available yet. Open Terminal for the session output.");
        timer = setTimeout(poll, page.more ? 0 : 1500);
      } catch {
        if (current()) {
          if (staleTimer === undefined) staleTimer = setTimeout(() => { staleTimer = undefined; if (active) setStale(true); }, 3000);
          timer = setTimeout(poll, 2500);
        }
      } finally {
        if (inFlight === started) inFlight = undefined;
      }
    }
    const resume = () => {
      generation++;
      clearTimeout(timer);
      clearTimeout(staleTimer);
      staleTimer = undefined;
      if (document.visibilityState === "hidden") return;
      // Returning clears an earlier warning; it shows again only if no read lands within the same grace period.
      setStale(false);
      staleTimer = setTimeout(() => { staleTimer = undefined; if (active) setStale(true); }, 3000);
      void poll();
    };
    document.addEventListener("visibilitychange", resume);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(staleTimer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [api, id]);
  return <div className="conversation">
    <p className="quiet">{source === "recording" ? "Recorded messages and signals. Open Terminal for complete output." : "Provider conversation"}</p>
    {messages.map(message => <article className={`chat-message ${message.role === "user" ? "from-user" : ""}`} key={message.id}>
      <div className="chat-meta"><strong>{message.toolName || (message.role === "assistant" ? "Agent" : message.role === "user" ? "You" : message.role)}</strong>{message.ts && <time>{new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}</div>
      <div className="chat-text">{message.text}</div>
    </article>)}
    <p className="conversation-status quiet" role="status">{stale ? loaded ? "Conversation may be stale; showing the last received messages." : "Can’t reach the host. Conversation hasn’t loaded." : note}</p>
  </div>;
}

export function ProjectFiles({ id, online }: { id: string; online: boolean }) {
  const api = useApi();
  const [path, setPath] = useState("");
  const [file, setFile] = useState<ProjectFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  async function open(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !online || !path.trim()) return;
    const current = ++revision.current;
    setBusy(true); setError(""); setFile(null);
    try { const value = await api<ProjectFile>(`/sessions/${id}/file?path=${encodeURIComponent(path.trim())}`); if (current === revision.current) setFile(value); }
    catch (error) { if (current === revision.current) setError((error as Error).message); }
    finally { if (current === revision.current) setBusy(false); }
  }
  return <div className="project-files">
    <h2>Project files</h2><p className="quiet">Open a file inside this session’s project. Content is displayed as text or a supported image.</p>
    <form onSubmit={open}><label htmlFor="project-file">Project-relative path</label><div className="file-path"><input id="project-file" value={path} onChange={event => setPath(event.target.value)} placeholder="src/index.ts" autoComplete="off" /><button className="primary stable-action" aria-busy={busy} disabled={busy || !online || !path.trim()}>{busy && <RefreshCw className="is-refreshing" size={16} />}Open file</button></div></form>
    {!busy && error && <p className="error" role="alert">{error}</p>}
    {file && <><p className="quiet">{file.path} · {file.size.toLocaleString()} bytes{!online ? " · cached" : ""}</p>
      {file.text !== undefined ? <pre className="file-preview">{file.text}</pre> : file.base64 && /^image\/(png|jpeg|gif|webp)$/.test(file.mimeType) ? <img className="file-image" src={`data:${file.mimeType};base64,${file.base64}`} alt={file.name} /> : <p className="quiet">Preview is not available for this file type.</p>}
    </>}
  </div>;
}

type Answer = { requestId: string; promptId: number; option?: number; text?: string };
const answers = new Map<string, Answer>();
export function PromptDecision({ sessionId, backend, prompt, canAnswer, controlId, refresh, onRefused, openTerminal }: {
  sessionId: string; backend?: Session["backend"]; prompt: Prompt; canAnswer: boolean; controlId?: string; refresh: () => void; onRefused: () => void; openTerminal: () => void;
}) {
  const api = useApi();
  const machine = useMachines().active.id;
  const cacheKey = `${machine}/${sessionId}/${prompt.id}`;
  const pending = useRef(answers.get(cacheKey));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(pending.current ? "Earlier answer delivery remains unconfirmed. Check Terminal before retrying." : "");
  const [reply, setReply] = useState("");
  async function deliver(option?: number, text?: string) {
    if (!canAnswer || busy) return;
    const retrying = Boolean(pending.current);
    pending.current ??= { requestId: crypto.randomUUID(), promptId: prompt.id, ...(option !== undefined ? { option } : {}), ...(text ? { text } : {}) };
    answers.set(cacheKey, pending.current);
    setBusy(true); setMessage("");
    try {
      const receipt = await api<{ state: string; result: string }>(`/sessions/${sessionId}/answer`, pending.current, undefined, controlId);
      if (receipt.state !== "delivered") throw new Error("Delivery is uncertain. Check Terminal before retrying.");
      pending.current = undefined; answers.delete(cacheKey);
      setMessage(receipt.result === "closed" ? "Answer delivered. Waiting for the dialog to close." : receipt.result === "changed" ? "The prompt changed. Refreshing before another answer." : "The dialog remains open. Check Terminal.");
    } catch (error) {
      if (isControlRefusal(error)) { onRefused(); if (!retrying) { pending.current = undefined; answers.delete(cacheKey); } }
      else if (error instanceof ApiError && ["prompt-changed", "unsupported", "invalid-option", "text-not-accepted"].includes(error.code ?? "")) { pending.current = undefined; answers.delete(cacheKey); }
      setMessage((error as Error).message);
    } finally { setBusy(false); refresh(); }
  }
  const feedText = backend === "cmux" && prompt.source === "protocol" && prompt.acceptsText && Boolean(prompt.hash);
  const terminalOnly = !feedText && (prompt.multiSelect || !prompt.hash || !prompt.options.length);
  const textReply = prompt.acceptsText && prompt.kind !== "yes-no" && (backend !== "cmux" || prompt.source === "protocol");
  return <section className="prompt-decision" aria-label="Session needs your decision">
    <strong>{prompt.title}</strong>{prompt.detail && <pre>{prompt.detail}</pre>}
    {prompt.destructive && <p className="error">Destructive command: {prompt.destructive.pattern.replace(/-/g, " ")}</p>}
    {terminalOnly ? backend === "cmux" ? <p className="quiet">Answer this prompt in native cmux on the machine.</p> : <button className="text-button" onClick={openTerminal}>Open Terminal to answer this prompt</button> : <div className="prompt-options">
      {prompt.options.map(option => <button key={option.index} disabled={!canAnswer || busy || Boolean(pending.current)} onClick={() => void deliver(option.index)}>{option.label}</button>)}
      {textReply && <form onSubmit={event => { event.preventDefault(); void deliver(undefined, reply.trim()); }}><textarea aria-label="Reply instead" value={reply} onChange={event => setReply(event.target.value)} disabled={busy || Boolean(pending.current)} placeholder="Reply instead…" maxLength={32000} rows={feedText && !prompt.options.length ? 3 : 2} /><button disabled={!canAnswer || busy || Boolean(pending.current) || !reply.trim()}>Send reply</button></form>}
      {backend === "cmux" && prompt.acceptsText && !textReply && <p className="quiet">To reply with text, answer in native cmux on the machine.</p>}
    </div>}
    {!canAnswer && <p className="quiet">Connect with a controller or owner key and take control to answer.</p>}
    <p className="prompt-feedback" role="status">{!busy && message}</p>
    {pending.current && !busy && <button disabled={!canAnswer} onClick={() => void deliver()}>Retry same answer</button>}
  </section>;
}

export function SessionLifecycle({ session, role, online, controlId, refresh }: { session: Session; role: string; online: boolean; controlId?: string; refresh: () => void }) {
  const api = useApi();
  const machine = useMachines().active.id;
  const key = `${machine}/${session.id}`;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const lifecycle = lifecycles.use(key);
  const pending = lifecycle.pending;
  const [sendingId, setSendingId] = useState<string>();
  const inFlight = useRef(new Set<string>());
  const busy = Boolean(pending && sendingId === pending.requestId);
  const running = session.status === "running" || session.status === "starting";
  useEffect(() => {
    if (!online) return;
    if (session.status === "exited" && pending?.action === "stop")
      lifecycles.complete(key, pending.requestId, undefined, "Session has exited. The end request was not confirmed; you can resume explicitly.");
    else if (running && lifecycle.result?.id === session.id) lifecycles.clear(key);
  }, [key, online, session.status, session.id, running, pending, lifecycle.result]);
  async function act(action: "stop" | "resume") {
    if (busy || !online || role !== "owner") return;
    if (action === "stop" && !pending && !window.confirm("End this session? This stops the agent process and keeps its recording. Resume requires a saved provider conversation.")) return;
    const request = lifecycles.begin(key, { action, requestId: crypto.randomUUID() });
    if (inFlight.current.has(request.requestId)) return;
    inFlight.current.add(request.requestId);
    setSendingId(request.requestId);
    try {
      const result = await api<Session & { state?: string }>(`/sessions/${session.id}/${request.action}`, { requestId: request.requestId }, undefined, controlId);
      if (result.state === "uncertain") throw new Error("The machine could not confirm the result.");
      const settled = lifecycles.complete(key, request.requestId, request.action === "resume" && result.id ? { id: result.id } : undefined, request.action === "stop" ? "End requested. Refreshing." : "");
      if (settled && mounted.current && request.action === "resume" && result.id) window.location.hash = `${machine === "direct" ? "" : `/machines/${machine}`}/sessions/${result.id}/chat`;
      if (mounted.current) refresh();
    } catch (error) { lifecycles.fail(key, request.requestId, isMissionManaged(error) ? error.message : `${(error as Error).message} Check the session state before retrying.`); }
    finally { inFlight.current.delete(request.requestId); if (mounted.current) setSendingId(current => current === request.requestId ? undefined : current); }
  }
  if (role !== "owner") return null;
  const action = pending?.action ?? (running ? "stop" : "resume");
  if (!running && !session.resumable && !pending && !lifecycle.result && !lifecycle.message) return null;
  return <span className="lifecycle-control">{lifecycle.result ? <a className="text-button" href={`#${machine === "direct" ? "" : `/machines/${machine}`}/sessions/${lifecycle.result.id}/chat`}>Open resumed session</a> : (running || session.resumable || pending) && <button className="text-button stable-action" aria-busy={busy} disabled={!online || busy || (action === "stop" && session.capabilities?.inputControl === 1 && !controlId)} onClick={() => void act(action)}>{busy ? "Waiting…" : pending ? `Retry ${action === "stop" ? "end" : "resume"}` : running ? "End session" : "Resume session"}</button>}{lifecycle.message && !busy && <span className="error" role="status">{lifecycle.message}</span>}</span>;
}
