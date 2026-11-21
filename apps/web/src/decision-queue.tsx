import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { formatDecisionAnswer } from "./decision-answer";
import { Decision } from "./team-decision";
import { PromptDecision } from "./session-extras";
import { useSessionControl } from "./session-control";
import { useMachines } from "./machines";
import { ApiError, useApi, type DecisionQueue, type Me, type QueueDecision, type Session } from "./api";
import { requestStore } from "./requests";
import {
  applyDecisionQueueKey, createDecisionQueueState, formatWaitDuration, moveDecisionQueue,
  recommendationAnswers, reconcileDecisionQueue, removeAnsweredDecision, selectableOptions,
  selectDecisionAnswers,
} from "./decision-queue-model";
import type { SessionTab } from "./session-navigation";
import "./decision-queue.css";

export type DecisionQueueViewProps = {
  queue: DecisionQueue | null;
  current: boolean;
  failed: boolean;
  failureSince?: string;
  lastSeen: string;
  role: Me["role"];
  projects: Me["projects"];
  refresh: () => void;
  confirmAnswered: (key: string) => void;
  navigateSession: (sessionId: string, tab?: SessionTab) => void;
  answer: (decision: Exclude<QueueDecision, { kind: "session" }>, request: QueueAnswerRequest) => Promise<void>;
};

type KeyboardContext = Parameters<typeof applyDecisionQueueKey>[2];
type QueueAnswerRequest = { requestId: string; revision: number; text: string };
type StoredQueueAnswer = QueueAnswerRequest & { answerPath: string };
const queueAnswers = requestStore<StoredQueueAnswer, void>();
const inFlightAnswers = new Set<string>();

export function clearDecisionQueueRequests(machine: string) { queueAnswers.clearMachine(machine); }

function whenFailureStarted(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "an unknown time";
  return new Date(value).toLocaleString();
}

function roleLabel(role: string) {
  return role.replaceAll("-", " ").replace(/\b\w/g, character => character.toUpperCase());
}

export function DecisionQueueView({ queue, current, failed, failureSince, lastSeen, role, projects, refresh, confirmAnswered, navigateSession, answer }: DecisionQueueViewProps) {
  const api = useApi();
  const machine = useMachines().active.id;
  const [state, setState] = useState(() => createDecisionQueueState(current && !failed ? queue?.decisions : []));
  const stateRef = useRef(state);
  stateRef.current = state;
  const [detail, setDetail] = useState<Session | null>(null);
  const [detailReadFor, setDetailReadFor] = useState("");
  const [detailError, setDetailError] = useState("");
  const [sessionSubmitSignal, setSessionSubmitSignal] = useState(0);
  const [focusSelectionSignal, setFocusSelectionSignal] = useState(0);
  const [submittingKey, setSubmittingKey] = useState<string>();
  const page = useRef<HTMLElement>(null);
  const active = state.decisions.find(decision => decision.key === state.activeKey);
  const activeSessionId = active?.kind === "session" ? active.origin.id : "";
  const control = useSessionControl(activeSessionId);
  const controlSession = useRef(activeSessionId);
  const controlReady = controlSession.current === activeSessionId;
  const answerRequestKey = `${machine}/${active?.key ?? ""}`;
  const answerRequest = queueAnswers.use(answerRequestKey);
  const answerMessage = answerRequest.message;
  const activeDetailCurrent = Boolean(controlReady && activeSessionId && detail?.id === activeSessionId && detailReadFor === `${activeSessionId}/${lastSeen}`);

  useEffect(() => {
    if (controlSession.current === activeSessionId) return;
    control.forget(false);
    controlSession.current = activeSessionId;
  }, [activeSessionId, control.forget]);

  const unavailableRef = useRef(control.unavailable);
  unavailableRef.current = control.unavailable;
  useEffect(() => {
    const releaseOnHide = () => { if (document.visibilityState === "hidden") unavailableRef.current(); };
    document.addEventListener("visibilitychange", releaseOnHide);
    return () => document.removeEventListener("visibilitychange", releaseOnHide);
  }, [activeSessionId]);

  useEffect(() => {
    if (!current || failed || !queue) return;
    const liveKeys = new Set(queue.decisions.map(decision => decision.key));
    for (const previous of stateRef.current.decisions) {
      if (!liveKeys.has(previous.key)) queueAnswers.clear(`${machine}/${previous.key}`);
    }
    setState(previous => {
      const next = reconcileDecisionQueue(previous, queue.decisions);
      stateRef.current = next;
      return next;
    });
  }, [queue, current, failed, lastSeen, machine]);

  useEffect(() => {
    let live = true;
    setDetailError("");
    if (!current || failed || !activeSessionId) return () => { live = false; };
    const revision = control.generation.current;
    void api<Session>(`/sessions/${activeSessionId}`).then(session => {
      if (!live) return;
      setDetail(session);
      setDetailReadFor(`${activeSessionId}/${lastSeen}`);
      control.observe(session, revision);
    }, error => {
      if (live) setDetailError((error as Error).message || "Session details could not be loaded.");
    });
    return () => { live = false; };
  }, [api, activeSessionId, current, failed, lastSeen]);

  const canAnswer = active?.kind === "session"
    ? Boolean(controlReady && current && activeDetailCurrent && detail?.status === "running" && role !== "viewer" &&
      (detail.managedBy || detail.capabilities?.inputControl !== 1 || control.lease))
    : Boolean(current && active && role !== "viewer" && (active.kind !== "mission" || role === "owner"));
  const terminalOnly = active?.kind === "session" && Boolean(active.terminalOnly);
  const options = selectableOptions(active);
  const keyboardContext: KeyboardContext = {
    options,
    recommendedAnswers: recommendationAnswers(active),
    canAnswer: canAnswer && !answerRequest.pending,
    terminalOnly,
    destructive: active?.kind === "session" && Boolean(active.prompt.destructive),
    multiple: active?.kind !== "session" && active?.decision.answerMode === "multiple",
  };
  const keyboardRef = useRef<{ context: KeyboardContext; enabled: boolean }>({ context: keyboardContext, enabled: current && !failed });
  keyboardRef.current = { context: keyboardContext, enabled: current && !failed };

  function commit(next: ReturnType<typeof createDecisionQueueState>) {
    stateRef.current = next;
    setState(next);
  }

  async function sendAnswer(decision: Exclude<QueueDecision, { kind: "session" }>, text: string) {
    const requestKey = `${machine}/${decision.key}`;
    const previous = queueAnswers.read(requestKey).pending;
    if ((!previous && !text.trim()) || inFlightAnswers.has(requestKey)) return;
    const request = queueAnswers.begin(requestKey, previous ?? {
      requestId: crypto.randomUUID(), revision: decision.revision, text: text.trim(), answerPath: decision.answerPath,
    });
    inFlightAnswers.add(requestKey);
    setSubmittingKey(decision.key);
    try {
      await answer(decision, { requestId: request.requestId, revision: request.revision, text: request.text });
      queueAnswers.complete(requestKey, request.requestId);
      confirmAnswered(decision.key);
      commit(removeAnsweredDecision(stateRef.current, decision.key));
      refresh();
    } catch (error) {
      const message = (error as Error).message || "The answer was not confirmed.";
      queueAnswers.fail(requestKey, request.requestId, message, error instanceof ApiError && error.status >= 400 && error.status < 500);
      refresh();
    } finally {
      inFlightAnswers.delete(requestKey);
      setSubmittingKey(currentKey => currentKey === decision.key ? undefined : currentKey);
    }
  }

  function submitSelection(decision: QueueDecision | undefined, selected: readonly string[]) {
    if (!decision || !canAnswer) return;
    if (decision.kind === "session") {
      if (!selected.length) return;
      setSessionSubmitSignal(value => value + 1);
      return;
    }
    if (!selected.length && !queueAnswers.read(`${machine}/${decision.key}`).pending) return;
    void sendAnswer(decision, formatDecisionAnswer(selected, decision.decision.answerMode));
  }

  const actionRef = useRef<(key: string, answers: string[]) => void>(() => {});
  actionRef.current = (key, selected) => {
    const decision = stateRef.current.decisions.find(item => item.key === key);
    submitSelection(decision, selected);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const status = keyboardRef.current;
      if (!status.enabled) return;
      const target = event.target instanceof Element ? event.target as HTMLElement : null;
      const result = applyDecisionQueueKey(stateRef.current, {
        key: event.key, targetTagName: target?.tagName, targetIsContentEditable: target?.isContentEditable,
        altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
      }, status.context);
      if (!result.handled) return;
      event.preventDefault();
      const previous = stateRef.current;
      commit(result.state);
      if (result.submit) actionRef.current(result.submit.key, result.submit.answers);
      else if (result.state !== previous && (/^[1-9]$/.test(event.key) || event.key === "r")) setFocusSelectionSignal(value => value + 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!focusSelectionSignal) return;
    const target = state.selectedAnswers.length
      ? page.current?.querySelector<HTMLButtonElement>("[data-decision-queue-submit]")
      : page.current?.querySelector<HTMLElement>(".decision-queue-card");
    target?.focus();
  }, [focusSelectionSignal]);

  const navigateHref = (sessionId: string) => `#${machine === "direct" ? "" : `/machines/${machine}`}/sessions/${sessionId}/chat`;
  const move = (offset: -1 | 1) => commit(moveDecisionQueue(stateRef.current, offset));
  const selectAnswers = (answers: readonly string[]) => commit(selectDecisionAnswers(stateRef.current, answers));
  const projectLabel = (id?: string) => id ? projects.find(project => project.id === id)?.name ?? id : "";
  const currentIndex = active ? state.decisions.findIndex(decision => decision.key === active.key) : -1;
  const needsControl = active?.kind === "session" && controlReady && activeDetailCurrent && detail?.capabilities?.inputControl === 1 && !detail.managedBy;
  const activeControlId = controlReady ? control.lease?.id : undefined;
  const selectedSessionOption = active?.kind === "session" && state.selectedAnswers.length ? Number(state.selectedAnswers[0]) : undefined;

  return <section className="decision-queue-page" ref={page}>
    <header className="decision-queue-heading">
      <div><p className="decision-queue-eyebrow">Your work</p><h1>Decision queue</h1><p className="quiet">Answer one decision at a time. The queue keeps the host’s oldest-first order.</p></div>
      <button className="text-button decision-queue-refresh" type="button" onClick={refresh} aria-label="Refresh decisions"><RefreshCw size={16} />Refresh</button>
    </header>

    {failed ? <section className="decision-queue-message is-error" role="alert">
      <strong>The decision queue could not be refreshed.</strong><p>Failure started {whenFailureStarted(failureSince)}.</p><button className="text-button" type="button" onClick={refresh}>Try again</button>
    </section> : !current || !queue ? <p className="decision-queue-message" role="status">Refreshing decisions…</p> : <>
      {state.answeredElsewhere && <p className="decision-queue-elsewhere" role="status">Answered elsewhere.</p>}
      {!active ? <section className="decision-queue-empty"><p>No decisions wait on you.</p></section> : <>
        <div className="decision-queue-count" role="status"><strong>Decision {currentIndex + 1} of {state.decisions.length}</strong><span>Waiting {formatWaitDuration(active.since)}</span></div>
        <article className="decision-queue-card" aria-labelledby="decision-queue-title" tabIndex={-1}>
          <header className="decision-queue-origin">
            <span className="decision-queue-kind">{active.kind === "session" ? "Session decision" : active.kind === "team" ? "Team decision" : "Mission decision"}</span>
            <h2 id="decision-queue-title">{active.origin.title}</h2>
            <div className="decision-queue-origin-meta">
              {active.origin.projectId && <span>{projectLabel(active.origin.projectId)}</span>}
              {active.origin.team && <><span>Team: {active.origin.team.title}</span><span>Team role: {roleLabel(active.origin.team.role)} ({active.origin.team.role})</span></>}
            </div>
            {active.kind === "session" && <a className="decision-queue-session-link" href={navigateHref(active.origin.id)} onClick={event => { event.preventDefault(); navigateSession(active.origin.id); }}>Open session</a>}
          </header>

          {active.kind === "session" ? <div className="decision-queue-session">
            {active.terminalOnly && <p className="decision-queue-terminal-copy">Answer this prompt in the session terminal.</p>}
            {!activeDetailCurrent && <p className="quiet" role="status">{detailError ? "Session details could not be loaded. Refresh and try again." : "Checking session details…"}</p>}
            {activeDetailCurrent && needsControl && !active.terminalOnly && <div className="decision-queue-control">
              <span className="quiet">{control.lease ? "You have control" : control.holder ? `${control.holder.label} has control` : "Control is needed to answer"}</span>
              {control.message && <span className="quiet" role="status">{control.message}</span>}
              {!control.lease && role !== "viewer" && detail?.status === "running" && <button className="primary" type="button" disabled={!current || control.busy} onClick={() => { void control.claim(Boolean(control.holder)).then(refresh); }}>{control.busy ? "Updating…" : control.holder ? "Take over" : "Take control"}</button>}
            </div>}
            <div className="decision-queue-prompt"><PromptDecision key={`${active.key}/${active.prompt.id}`} sessionId={active.origin.id} backend={activeDetailCurrent ? detail?.backend : undefined}
              prompt={active.prompt} terminalOnlyOverride={Boolean(active.terminalOnly)} canAnswer={canAnswer} controlId={activeControlId}
              refresh={refresh} onRefused={() => { if (activeControlId && controlSession.current === activeSessionId && control.owned.current?.id === activeControlId) control.forget(); }} openTerminal={() => navigateSession(active.origin.id, "terminal")}
              selectionOnly selectedOption={selectedSessionOption} onOptionSelection={index => selectAnswers([String(index)])} submitSignal={sessionSubmitSignal}
              onDelivered={result => { if (result === "closed") { confirmAnswered(active.key); commit(removeAnsweredDecision(stateRef.current, active.key)); } }} /></div>
          </div> : <div className="decision-queue-decision">
            {active.kind === "team" && active.held && <p className="decision-queue-held">A halt holds this team. Your answer is kept, and work continues when the team resumes.</p>}
            {active.kind === "mission" && role !== "owner" && <p className="decision-queue-owner-only">Only the owner can answer mission decisions.</p>}
            <Decision key={active.key} decision={{ ...active.decision, revision: active.revision }} disabled={!current || submittingKey === active.key || Boolean(answerRequest.pending) || (active.kind === "mission" && role !== "owner") || role === "viewer"}
              member={active.origin.team ? { role: active.origin.team.role } : undefined}
              answer={text => { void sendAnswer(active, text); }} readOnly={active.kind === "mission" ? role !== "owner" : role === "viewer"}
              deferAnswer selectedAnswers={state.selectedAnswers} onSelectionChange={selectAnswers} />
            {(state.selectedAnswers.length > 0 || answerRequest.pending) && (active.kind !== "mission" || role === "owner") && <button className="primary decision-queue-submit" type="button" data-decision-queue-submit disabled={!current || submittingKey === active.key || role === "viewer"} onClick={() => submitSelection(active, state.selectedAnswers)}>
              {answerRequest.pending ? "Retry same answer" : active.decision.answerMode === "multiple" ? "Submit selected answers" : "Submit selected answer"}
            </button>}
          </div>}
          {answerMessage && <p className="decision-queue-answer-error" role="alert">{answerMessage}</p>}
        </article>
        <nav className="decision-queue-navigation" aria-label="Decision queue navigation">
          <button className="text-button" type="button" disabled={currentIndex <= 0} onClick={() => move(-1)}>Previous</button>
          <button className="primary" type="button" disabled={currentIndex < 0 || currentIndex >= state.decisions.length - 1} onClick={() => move(1)}>Skip decision</button>
        </nav>
      </>}
      <p className="decision-queue-keys" aria-label="Keyboard shortcuts"><strong>Keys</strong> <kbd>j</kbd> or <kbd>↓</kbd> next · <kbd>k</kbd> or <kbd>↑</kbd> previous · <kbd>s</kbd> skip · <kbd>1–9</kbd> select · <kbd>r</kbd> recommended · <kbd>Enter</kbd> answer</p>
      {answerMessage && !active && <p className="decision-queue-answer-error" role="alert">{answerMessage}</p>}
    </>}
  </section>;
}
