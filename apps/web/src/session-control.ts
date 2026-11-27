import { useEffect, useRef, useState } from "react";
import { isControlRefusal, useApi, type ControlLease, type Session } from "./api";
import { foreground } from "./live-refresh";

type LeasePhase =
  | { kind: "unheld" }
  | { kind: "claiming"; token: number; lease: ControlLease | null; reconnecting: boolean }
  | { kind: "held"; lease: ControlLease; reconnecting: boolean; renewing: boolean }
  | { kind: "releasing"; token: number; lease: ControlLease };

const leaseOf = (phase: LeasePhase): ControlLease | null =>
  phase.kind === "held" || phase.kind === "claiming" ? phase.lease : null;

export function useSessionControl(id: string) {
  const api = useApi();
  const [phaseState, setPhaseState] = useState<{ id: string; value: LeasePhase }>({ id, value: { kind: "unheld" } });
  const [holderState, setHolderState] = useState<{ id: string; value: ControlLease | null }>({ id, value: null });
  const [messageState, setMessageState] = useState<{ id: string; value: string }>({ id, value: "" });
  const currentPhase: LeasePhase = phaseState.id === id ? phaseState.value : { kind: "unheld" };
  const lease = leaseOf(currentPhase);
  const holder = holderState.id === id ? holderState.value : null;
  const message = messageState.id === id ? messageState.value : "";
  const busy = currentPhase.kind === "claiming" || currentPhase.kind === "releasing";
  const setHolder = (value: ControlLease | null | ((current: ControlLease | null) => ControlLease | null)) => setHolderState(previous => {
    const current = previous.id === id ? previous.value : null;
    return { id, value: typeof value === "function" ? value(current) : value };
  });
  const setMessage = (value: string) => setMessageState({ id, value });
  const phase = useRef<LeasePhase>({ kind: "unheld" });
  const readPhase = (): LeasePhase => phase.current;
  const owned = useRef<ControlLease | null>(null);
  const generation = useRef(0);
  const opToken = useRef(0);
  const mounted = useRef(true);
  const setCurrentPhase = (next: LeasePhase) => {
    phase.current = next;
    owned.current = leaseOf(next);
    setPhaseState({ id, value: next });
  };
  const releaseRequest = (control: ControlLease) => {
    let timer: number | undefined, sending = false;
    const expired = () => Date.now() >= control.expiresAt;
    const stop = () => {
      window.removeEventListener("online", release);
      if (timer !== undefined) window.clearTimeout(timer);
      window.clearTimeout(expiry);
    };
    const release = () => {
      if (sending) return;
      if (expired()) { stop(); return; }
      sending = true;
      void api(`/sessions/${id}/control`, { action: "release", leaseId: control.id }).then(() => {
        stop();
      }, error => {
        if (isControlRefusal(error) || expired()) { stop(); return; }
        window.addEventListener("online", release, { once: true });
        if (timer !== undefined) window.clearTimeout(timer);
        if (navigator.onLine) timer = window.setTimeout(release, 1000);
      }).finally(() => { sending = false; });
    };
    const expiry = window.setTimeout(stop, Math.max(0, control.expiresAt - Date.now()));
    release();
  };
  const forget = (release = true) => {
    generation.current++;
    const previous = leaseOf(phase.current);
    setCurrentPhase({ kind: "unheld" });
    if (previous) {
      setHolder(current => current?.id === previous.id ? null : current);
      setMessage("");
      if (release) void releaseRequest(previous);
    }
  };
  const unavailable = () => { if (document.visibilityState === "hidden") forget(true); };
  const observe = (session: Session, revision: number) => {
    if (phase.current.kind === "claiming" || phase.current.kind === "releasing" || revision !== generation.current) return;
    setHolder(session.control ?? null);
    const previous = leaseOf(phase.current);
    if (previous && (session.control?.id !== previous.id ||
      session.control.expiresAt <= Date.now() || session.status !== "running")) forget();
  };
  const claim = async (takeover = false) => {
    if (phase.current.kind === "claiming" || phase.current.kind === "releasing") return;
    const prior = phase.current.kind === "held" ? phase.current.lease : null;
    const reconnecting = phase.current.kind === "held" && phase.current.reconnecting;
    const token = ++opToken.current;
    setCurrentPhase({ kind: "claiming", token, lease: prior, reconnecting });
    const revision = ++generation.current;
    setMessage("");
    try {
      const result = await api<{ control: ControlLease | null }>(`/sessions/${id}/control`, { action: "claim", takeover });
      if (!mounted.current || !foreground() || revision !== generation.current) {
        if (result.control) void releaseRequest(result.control);
        return;
      }
      generation.current++;
      setCurrentPhase(result.control ? { kind: "held", lease: result.control, reconnecting: false, renewing: false } : { kind: "unheld" });
      setHolder(result.control);
      setMessage(result.control ? "" : "Control was not granted. Refresh and try again.");
    } catch (error) {
      if (mounted.current && revision === generation.current) {
        const current = readPhase();
        if (current.kind === "claiming" && current.token === token && current.reconnecting && current.lease && !isControlRefusal(error)) {
          setCurrentPhase({ kind: "held", lease: current.lease, reconnecting: true, renewing: false });
        } else {
          forget();
          if (isControlRefusal(error) && error.control !== undefined) setHolder(error.control);
        }
        setMessage((error as Error).message);
      }
    } finally {
      const current = readPhase();
      if (current.kind === "claiming" && current.token === token) {
        const next: LeasePhase = current.lease
          ? { kind: "held", lease: current.lease, reconnecting: current.reconnecting, renewing: false }
          : { kind: "unheld" };
        if (mounted.current) setCurrentPhase(next);
        else { phase.current = next; owned.current = leaseOf(next); }
      }
    }
  };
  const release = async () => {
    if (phase.current.kind !== "held") return;
    const previous = phase.current.lease;
    generation.current++;
    const token = ++opToken.current;
    setCurrentPhase({ kind: "releasing", token, lease: previous });
    setHolder(current => current?.id === previous.id ? null : current);
    setMessage("");
    const revision = generation.current;
    try {
      await api(`/sessions/${id}/control`, { action: "release", leaseId: previous.id });
    } catch {
      releaseRequest(previous);
      if (mounted.current && revision === generation.current)
        setMessage("Control release was not confirmed. This device stopped sending; release will retry when online.");
    } finally {
      if (revision === generation.current) generation.current++;
      const current = readPhase();
      if (current.kind === "releasing" && current.token === token) {
        if (mounted.current) setCurrentPhase({ kind: "unheld" });
        else { phase.current = { kind: "unheld" }; owned.current = null; }
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      const previous = leaseOf(phase.current);
      phase.current = { kind: "unheld" };
      owned.current = null;
      if (previous) releaseRequest(previous);
    };
  }, [id]);
  useEffect(() => {
    if (!lease) return;
    const expire = setTimeout(() => {
      if (phase.current.kind === "held" && phase.current.lease.id === lease.id) {
        setCurrentPhase({ ...phase.current, reconnecting: true });
        if (foreground()) void claim();
      }
    }, Math.max(0, lease.expiresAt - Date.now()));
    const renew = async () => {
      if (phase.current.kind !== "held" || phase.current.renewing || !foreground() || phase.current.lease.id !== lease.id) return;
      phase.current.renewing = true;
      const revision = generation.current;
      try {
        const result = await api<{ control: ControlLease | null }>(`/sessions/${id}/control`, { action: "renew", leaseId: lease.id });
        if (mounted.current && revision === generation.current && phase.current.kind === "held" && phase.current.lease.id === lease.id) {
          if (result.control?.id === lease.id && foreground()) {
            generation.current++;
            setCurrentPhase({ kind: "held", lease: result.control, reconnecting: false, renewing: false });
            setHolder(result.control);
          } else {
            setCurrentPhase({ kind: "held", lease: phase.current.lease, reconnecting: true, renewing: false });
            if (foreground()) void claim();
          }
        }
      } catch {
        if (mounted.current && revision === generation.current && phase.current.kind === "held") {
          setCurrentPhase({ ...phase.current, reconnecting: true, renewing: false });
          if (foreground()) void claim();
        }
      } finally {
        if (phase.current.kind === "held" && phase.current.lease.id === lease.id) phase.current.renewing = false;
      }
    };
    const resume = () => {
      if (phase.current.kind === "held" && phase.current.reconnecting) void claim();
      else void renew();
    };
    const timer = setInterval(resume, 10000);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      clearTimeout(expire); clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, [id, lease]);
  return { lease, holder, message, busy, claim, release, forget, unavailable, observe, generation, owned };
}
