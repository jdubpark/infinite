import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
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
  selectDecisionAnswers, type DecisionQueueState,
} from "./decision-queue-model";
import type { SessionTab } from "./session-navigation";
import "./decision-queue.css";

type AnswerableDecision = Exclude<QueueDecision, { kind: "session" }>;
type QueueAnswerRequest = { requestId: string; revision: number; text: string };
type KeyboardContext = Parameters<typeof applyDecisionQueueKey>[2];

export type DecisionQueueViewProps = {
  /** The last queue the host reported, or null before the first read and on a host without the route. It stays while a later read is in flight or fails. */
  queue: DecisionQueue | null;
  /** When the host reported that queue. */
  readAt: string;
  /** True while that queue is the host's current answer. Nothing is answered otherwise. */
  current: boolean;
  /** True once the queue has gone without a refresh for about three seconds. */
  stale: boolean;
  failed: boolean;
  failureSince?: string;
  /** True when the host has no decision queue route, so there is nothing to retry. */
  unavailable: boolean;
  role: Me["role"];
  /** False on a host that takes no prompt answers from a client. */
  promptAnswers: boolean;
  projects: Me["projects"];
  refresh: () => void;
  confirmAnswered: (key: string) => void;
  navigateSession: (sessionId: string, tab?: SessionTab) => void;
  answer: (decision: AnswerableDecision, request: QueueAnswerRequest) => Promise<void>;
};

const queueAnswers = requestStore<QueueAnswerRequest, void>();
const inFlightAnswers = new Set<string>();

export function clearDecisionQueueRequests(machine: string) { queueAnswers.clearMachine(machine); }

function clockTime(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "an unknown time";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function roleLabel(role: string) {
  return role.replaceAll("-", " ").replace(/^\w/, character => character.toUpperCase());
}

function shorten(text: string) {
  const line = text.replace(/\s+/g, " ");
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/**
 * Every decision that waits on a person, one at a time. Nothing is sent without the person's own action on the
 * decision shown: an option is selected first and sent second, and a recommendation only marks an option.
 * Temporary states change words and disabled states in place; they add and remove no lines.
 */
export function DecisionQueueView({ queue, readAt, current, stale, failed, failureSince, unavailable, role, promptAnswers, projects, refresh, confirmAnswered, navigateSession, answer }: DecisionQueueViewProps) {
  const api = useApi();
  const machine = useMachines().active.id;
  const [state, setState] = useState(() => createDecisionQueueState(queue?.decisions));
  const stateRef = useRef(state);
  stateRef.current = state;
  const [detail, setDetail] = useState<Session | null>(null);
  const [detailFailedFor, setDetailFailedFor] = useState("");
  const [sessionSubmitSignal, setSessionSubmitSignal] = useState(0);
  const [focusSelectionSignal, setFocusSelectionSignal] = useState(0);
  const [submittingKey, setSubmittingKey] = useState<string>();
  const [dismissedMessage, setDismissedMessage] = useState("");
  const page = useRef<HTMLElement>(null);
  const active = queue ? state.decisions.find(decision => decision.key === state.activeKey) : undefined;
  const activeSessionId = active?.kind === "session" ? active.origin.id : "";
  const control = useSessionControl(activeSessionId);
  const controlSession = useRef(activeSessionId);
  const controlReady = controlSession.current === activeSessionId;
  const answerRequest = queueAnswers.use(`${machine}/${active?.key ?? ""}`);
  // The last read of the active session. It stays while the next read is in flight, and goes when a read fails.
  const activeDetail = controlReady && activeSessionId && detail?.id === activeSessionId ? detail : null;

  function commit(next: DecisionQueueState) {
    stateRef.current = next;
    setState(next);
  }

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
    if (!queue) return;
    const listed = new Set(queue.decisions.map(decision => decision.key));
    for (const previous of stateRef.current.decisions) {
      if (!listed.has(previous.key)) queueAnswers.clear(`${machine}/${previous.key}`);
    }
    commit(reconcileDecisionQueue(stateRef.current, queue.decisions));
  }, [queue, machine]);

  useEffect(() => {
    if (!current || !activeSessionId) return;
    let live = true;
    const revision = control.generation.current;
    void api<Session>(`/sessions/${activeSessionId}`).then(session => {
      if (!live) return;
      setDetail(session);
      setDetailFailedFor("");
      control.observe(session, revision);
    }, () => {
      if (!live) return;
      setDetail(null);
      setDetailFailedFor(activeSessionId);
    });
    return () => { live = false; };
  }, [api, activeSessionId, current, readAt]);

  const terminalOnly = active?.kind === "session" && Boolean(active.terminalOnly);
  const needsControl = Boolean(activeDetail && activeDetail.capabilities?.inputControl === 1 && !activeDetail.managedBy);
  const readOnly = role === "viewer" || (active?.kind === "mission" && role !== "owner");
  const canAnswer = !active || !current || readOnly ? false
    : active.kind === "session" ? promptAnswers && activeDetail?.status === "running" && (!needsControl || Boolean(control.lease))
    : true;
  const sessionNote = active?.kind !== "session" ? ""
    : terminalOnly ? "Answer this prompt in the session’s terminal."
    : role === "viewer" ? "A viewer cannot answer."
    : !promptAnswers ? "This host takes no prompt answers from the web client."
    : !activeDetail ? (detailFailedFor === activeSessionId ? "The session could not be read. Answers are off until it can." : "Checking the session…")
    : activeDetail.status !== "running" ? "The session is not running."
    : !needsControl ? "No control is needed to answer."
    : control.lease ? "You have control."
    : control.holder ? `${control.holder.label} has control.`
    : "Take control to answer.";
  const claimShown = active?.kind === "session" && !terminalOnly && role !== "viewer" && promptAnswers && needsControl && !control.lease && activeDetail?.status === "running";
  const busyHere = Boolean(active) && submittingKey === active?.key;
  const pendingAnswer = active && active.kind !== "session" ? answerRequest.pending : undefined;
  const options = selectableOptions(active);
  const keyboardContext: KeyboardContext = {
    options,
    recommendedAnswers: recommendationAnswers(active),
    canAnswer: canAnswer && !pendingAnswer,
    terminalOnly,
    destructive: active?.kind === "session" && Boolean(active.prompt.destructive),
    multiple: active?.kind !== "session" && active?.decision.answerMode === "multiple",
  };
  const keyboardRef = useRef({ context: keyboardContext, enabled: Boolean(queue) });
  keyboardRef.current = { context: keyboardContext, enabled: Boolean(queue) };

  async function sendAnswer(decision: AnswerableDecision, text: string) {
    if (decision.key !== active?.key || !canAnswer) return;
    const requestKey = `${machine}/${decision.key}`;
    const previous = queueAnswers.read(requestKey).pending;
    if ((!previous && !text.trim()) || inFlightAnswers.has(requestKey)) return;
    // An unconfirmed answer is sent again as it was, under its own request id, so the host can answer from its receipt.
    const request = queueAnswers.begin(requestKey, previous ?? { requestId: crypto.randomUUID(), revision: decision.revision, text: text.trim() });
    inFlightAnswers.add(requestKey);
    setSubmittingKey(decision.key);
    setDismissedMessage("");
    try {
      await answer(decision, request);
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
    if (!decision || decision.key !== active?.key || !canAnswer || !selected.length) return;
    if (decision.kind === "session") {
      setSessionSubmitSignal(value => value + 1);
      return;
    }
    if (pendingAnswer) return;
    void sendAnswer(decision, formatDecisionAnswer(selected, decision.decision.answerMode));
  }

  const actionRef = useRef<(key: string, answers: string[]) => void>(() => {});
  actionRef.current = (key, selected) => submitSelection(stateRef.current.decisions.find(item => item.key === key), selected);

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

  const sessionHref = (sessionId: string) => `#${machine === "direct" ? "" : `/machines/${machine}`}/sessions/${sessionId}/chat`;
  const move = (offset: -1 | 1) => commit(moveDecisionQueue(stateRef.current, offset));
  const selectAnswers = (answers: readonly string[]) => commit(selectDecisionAnswers(stateRef.current, answers));
  const projectLabel = (id?: string) => id ? projects.find(project => project.id === id)?.name ?? id : "";
  const currentIndex = active ? state.decisions.findIndex(decision => decision.key === active.key) : -1;
  const activeControlId = controlReady ? control.lease?.id : undefined;
  const selectedSessionOption = active?.kind === "session" && state.selectedAnswers.length ? Number(state.selectedAnswers[0]) : undefined;
  const answerMessage = answerRequest.message && answerRequest.message !== dismissedMessage ? answerRequest.message : "";
  const noticeShown = Boolean(queue) && (stale || Boolean(answerMessage) || Boolean(pendingAnswer) || state.activeLeft);

  return <section className="decision-queue-page" ref={page}>
    <header className="decision-queue-heading">
      <p className="decision-queue-eyebrow">Your work</p>
      <h1>Decision queue</h1>
      <p className="quiet">Answer one decision at a time, oldest first.</p>
    </header>

    {!queue ? unavailable ? <p className="decision-queue-message" role="status">The decision queue is not available on this host.</p>
    : failed ? <section className="decision-queue-message is-error" role="alert">
      <strong>The decision queue could not be read.</strong><p>Failing since {clockTime(failureSince)}.</p><button className="text-button" type="button" onClick={refresh}>Try again</button>
    </section> : <p className="decision-queue-message" role="status">Reading decisions…</p>
    : !active ? <section className="decision-queue-empty"><p>No decisions wait on you.</p></section> : <>
      <div className="decision-queue-count" role="status"><strong>Decision {currentIndex + 1} of {state.decisions.length}</strong><span>Waiting {formatWaitDuration(active.since)}</span></div>
      <article className={`decision-queue-card${stale ? " is-stale" : ""}`} aria-labelledby="decision-queue-title" tabIndex={-1}>
        <header className="decision-queue-origin">
          <span className="decision-queue-kind">{active.kind === "session" ? "Session decision" : active.kind === "team" ? "Team decision" : "Mission decision"}</span>
          <h2 id="decision-queue-title">{active.origin.title}</h2>
          <div className="decision-queue-origin-meta">
            {active.origin.projectId && <span>{projectLabel(active.origin.projectId)}</span>}
            {active.origin.team && <><span>Team: {active.origin.team.title}</span><span>Role: {roleLabel(active.origin.team.role)}</span></>}
          </div>
          {active.kind === "session" && <a className="decision-queue-session-link" href={sessionHref(active.origin.id)} onClick={event => { event.preventDefault(); navigateSession(active.origin.id); }}>Open session</a>}
        </header>

        {active.kind === "session" ? <div className="decision-queue-session">
          <div className="decision-queue-control">
            <p className="quiet" role="status">{control.message || sessionNote}</p>
            {claimShown && <button className="primary" type="button" disabled={!current || control.busy} onClick={() => { void control.claim(Boolean(control.holder)).then(refresh); }}>{control.busy ? "Updating…" : control.holder ? "Take over" : "Take control"}</button>}
          </div>
          <div className="decision-queue-prompt"><PromptDecision key={`${active.key}/${active.prompt.id}`} sessionId={active.origin.id} backend={activeDetail?.backend}
            prompt={active.prompt} terminalOnlyOverride={terminalOnly} canAnswer={canAnswer} controlId={activeControlId}
            refresh={refresh} onRefused={() => { if (activeControlId && controlSession.current === activeSessionId && control.owned.current?.id === activeControlId) control.forget(); }} openTerminal={() => navigateSession(active.origin.id, "terminal")}
            selectionOnly selectedOption={selectedSessionOption} onOptionSelection={index => selectAnswers([String(index)])} submitSignal={sessionSubmitSignal}
            onDelivered={result => { if (result === "closed") { confirmAnswered(active.key); commit(removeAnsweredDecision(stateRef.current, active.key)); } }} /></div>
        </div> : <div className="decision-queue-decision">
          {active.kind === "team" && active.held && <p className="decision-queue-held">A halt holds this team. Your answer is kept, and work continues when the team resumes.</p>}
          {readOnly && <p className="decision-queue-readonly">{active.kind === "mission" ? "Only the owner can answer mission decisions." : "A viewer cannot answer."}</p>}
          <Decision key={active.key} decision={{ ...active.decision, revision: active.revision }} from={active.kind === "mission" ? "Mission" : "Team"}
            disabled={!canAnswer || busyHere || Boolean(pendingAnswer)} answer={text => { void sendAnswer(active, text); }} readOnly={readOnly}
            deferAnswer selectedAnswers={state.selectedAnswers} onSelectionChange={selectAnswers} />
          {!readOnly && options.length > 0 && <button className="primary decision-queue-submit" type="button" data-decision-queue-submit disabled={!canAnswer || busyHere || Boolean(pendingAnswer) || state.selectedAnswers.length === 0} onClick={() => submitSelection(active, state.selectedAnswers)}>
            {active.decision.answerMode === "multiple" ? "Submit selected answers" : "Submit selected answer"}
          </button>}
        </div>}
      </article>
      <nav className="decision-queue-navigation" aria-label="Decision queue navigation">
        <button className="text-button" type="button" disabled={currentIndex <= 0} onClick={() => move(-1)}>Previous</button>
        <button className="text-button" type="button" disabled={currentIndex >= state.decisions.length - 1} onClick={() => move(1)}>Skip</button>
      </nav>
      <p className="decision-queue-keys" aria-label="Keyboard shortcuts"><strong>Keys</strong> <kbd>j</kbd> or <kbd>↓</kbd> next · <kbd>k</kbd> or <kbd>↑</kbd> previous · <kbd>s</kbd> skip · <kbd>1–9</kbd> select · <kbd>r</kbd> recommended · <kbd>Enter</kbd> send</p>
    </>}

    {noticeShown && <div className="decision-queue-notice" role={stale || answerMessage ? "alert" : "status"}>
      {stale && <div><span>The decision queue has not refreshed since {clockTime(readAt)}. Answers are off until it does.</span></div>}
      {answerMessage && <div><span>{answerMessage}</span><button type="button" className="decision-queue-dismiss" aria-label="Dismiss notice" onClick={() => setDismissedMessage(answerMessage)}><X size={15} /></button></div>}
      {pendingAnswer && active && active.kind !== "session" && <div><span>Unconfirmed answer: {shorten(pendingAnswer.text)}</span><button type="button" className="text-button" disabled={!canAnswer || busyHere} onClick={() => { void sendAnswer(active, pendingAnswer.text); }}>Retry same answer</button></div>}
      {state.activeLeft && <div><span>The decision shown before is no longer in the queue.</span></div>}
    </div>}
  </section>;
}
