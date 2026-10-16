import { useEffect, useRef, useState } from "react";
import type { Prompt } from "@infinite/attention";
import { ApiError, isControlRefusal, useApi, type ChatMessage, type MessagesPage, type ProjectFile, type Session } from "./api";
import { useMachines } from "./machines";
import { lifecycles } from "./requests";

export function Conversation({ id }: { id: string }) {
  const api = useApi();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [note, setNote] = useState("Loading conversation…");
  const [source, setSource] = useState("");
  useEffect(() => {
    let active = true, cursor: string | number = "";
    let timer: ReturnType<typeof setTimeout>;
    const collected = new Map<string, ChatMessage>();
    async function poll() {
      try {
        const page = await api<MessagesPage>(`/sessions/${id}/messages?limit=100${cursor === "" ? "" : `&after=${encodeURIComponent(cursor)}`}`);
        if (!active) return;
        for (const message of page.messages) collected.set(message.id, message);
        while (collected.size > 500) collected.delete(collected.keys().next().value!);
        cursor = page.cursor; setMessages([...collected.values()]); setSource(page.source ?? "");
        setNote(collected.size ? "" : "No structured messages are available yet. Open Terminal for the session output.");
        timer = setTimeout(poll, page.more ? 0 : 1500);
      } catch (error) {
        if (active) { setNote(`${(error as Error).message} Conversation may be stale.`); timer = setTimeout(poll, 2500); }
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [api, id]);
  return <div className="conversation">
    <p className="quiet">{source === "recording" ? "Recorded messages and signals. Open Terminal for complete output." : "Provider conversation"}</p>
    {messages.map(message => <article className={`chat-message ${message.role === "user" ? "from-user" : ""}`} key={message.id}>
      <div className="chat-meta"><strong>{message.toolName || (message.role === "assistant" ? "Agent" : message.role === "user" ? "You" : message.role)}</strong>{message.ts && <time>{new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}</div>
      <div className="chat-text">{message.text}</div>
    </article>)}
    {note && <p className="quiet" role="status">{note}</p>}
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
    <form onSubmit={open}><label htmlFor="project-file">Project-relative path</label><div className="file-path"><input id="project-file" value={path} onChange={event => setPath(event.target.value)} placeholder="src/index.ts" autoComplete="off" /><button className="primary" disabled={busy || !online || !path.trim()}>{busy ? "Opening…" : "Open file"}</button></div></form>
    {error && <p className="error" role="alert">{error}</p>}
    {file && <><p className="quiet">{file.path} · {file.size.toLocaleString()} bytes{!online ? " · cached" : ""}</p>
      {file.text !== undefined ? <pre className="file-preview">{file.text}</pre> : file.base64 && /^image\/(png|jpeg|gif|webp)$/.test(file.mimeType) ? <img className="file-image" src={`data:${file.mimeType};base64,${file.base64}`} alt={file.name} /> : <p className="quiet">Preview is not available for this file type.</p>}
    </>}
  </div>;
}

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; abort(): void; onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null };
type SpeechWindow = Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
export function Dictation({ disabled, onText }: { disabled: boolean; onText: (text: string) => void }) {
  const Constructor = (window as SpeechWindow).SpeechRecognition ?? (window as SpeechWindow).webkitSpeechRecognition;
  const recognition = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => () => { recognition.current?.abort(); }, []);
  useEffect(() => { if (disabled) recognition.current?.stop(); }, [disabled]);
  if (!Constructor) return null;
  function toggle() {
    if (listening) { recognition.current?.stop(); return; }
    if (disabled || !Constructor) return;
    const current = new Constructor(); recognition.current = current;
    current.lang = navigator.language; current.interimResults = false; current.continuous = false;
    current.onresult = event => {
      const text: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index++) if (event.results[index].isFinal) text.push(event.results[index][0].transcript);
      if (text.length) onText(text.join(" "));
    };
    current.onerror = event => { setError(`Dictation unavailable: ${event.error}.`); setListening(false); };
    current.onend = () => setListening(false);
    setError("");
    try { current.start(); setListening(true); } catch { setError("Dictation could not start."); }
  }
  return <><button type="button" disabled={disabled} onClick={toggle} aria-pressed={listening} title="Browser speech service. Review the draft before sending.">{listening ? "Stop dictation" : "Dictate"}</button>{listening && <span role="status">Listening · review before Send</span>}{error && <span role="status">{error}</span>}</>;
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
    {message && <p role="status">{message}</p>}
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
    } catch (error) { lifecycles.fail(key, request.requestId, `${(error as Error).message} Check the session state before retrying.`); }
    finally { inFlight.current.delete(request.requestId); if (mounted.current) setSendingId(current => current === request.requestId ? undefined : current); }
  }
  if (role !== "owner") return null;
  const action = pending?.action ?? (running ? "stop" : "resume");
  if (!running && !session.resumable && !pending && !lifecycle.result && !lifecycle.message) return null;
  return <span className="lifecycle-control">{lifecycle.result ? <a className="text-button" href={`#${machine === "direct" ? "" : `/machines/${machine}`}/sessions/${lifecycle.result.id}/chat`}>Open resumed session</a> : (running || session.resumable || pending) && <button className="text-button" disabled={!online || busy || (action === "stop" && session.capabilities?.inputControl === 1 && !controlId)} onClick={() => void act(action)}>{busy ? "Waiting…" : pending ? `Retry ${action === "stop" ? "end" : "resume"}` : running ? "End session" : "Resume session"}</button>}{lifecycle.message && <span className="error" role="status">{lifecycle.message}</span>}</span>;
}
