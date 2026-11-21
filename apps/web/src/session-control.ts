import { useEffect, useRef, useState } from "react";
import { isControlRefusal, useApi, type ControlLease, type Session } from "./api";
import { foreground } from "./live-refresh";

export function useSessionControl(id: string) {
  const api = useApi();
  const [leaseState, setLeaseState] = useState<{ id: string; value: ControlLease | null }>({ id, value: null });
  const [holderState, setHolderState] = useState<{ id: string; value: ControlLease | null }>({ id, value: null });
  const [messageState, setMessageState] = useState<{ id: string; value: string }>({ id, value: "" });
  const lease = leaseState.id === id ? leaseState.value : null;
  const holder = holderState.id === id ? holderState.value : null;
  const message = messageState.id === id ? messageState.value : "";
  const setLease = (value: ControlLease | null) => setLeaseState({ id, value });
  const setHolder = (value: ControlLease | null | ((current: ControlLease | null) => ControlLease | null)) => setHolderState(previous => {
    const current = previous.id === id ? previous.value : null;
    return { id, value: typeof value === "function" ? value(current) : value };
  });
  const setMessage = (value: string) => setMessageState({ id, value });
  const [busy, setBusy] = useState(false);
  const owned = useRef<ControlLease | null>(null);
  const claiming = useRef(false);
  const reconnecting = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  // Retries last only while the lease is unexpired: after that the host has dropped it, so a release has nothing to do.
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
    const previous = owned.current;
    owned.current = null;
    reconnecting.current = false;
    setLease(null);
    if (previous) {
      setHolder(current => current?.id === previous.id ? null : current);
      setMessage("");
      if (release) void releaseRequest(previous);
    }
  };
  const unavailable = () => { if (document.visibilityState === "hidden") forget(true); };
  const observe = (session: Session, revision: number) => {
    if (claiming.current || revision !== generation.current) return;
    setHolder(session.control ?? null);
    const previous = owned.current;
    if (previous && (session.control?.id !== previous.id ||
      session.control.expiresAt <= Date.now() || session.status !== "running")) forget();
  };
  const claim = async (takeover = false) => {
    if (claiming.current) return;
    claiming.current = true;
    const revision = ++generation.current;
    setBusy(true); setMessage("");
    try {
      const result = await api<{ control: ControlLease | null }>(`/sessions/${id}/control`, { action: "claim", takeover });
      if (!mounted.current || !foreground() || revision !== generation.current) {
        if (result.control) void releaseRequest(result.control);
        return;
      }
      // A poll started while claim was pending still carries the old holder.
      // Fence that response as well as polls begun before the request.
      generation.current++;
      reconnecting.current = false;
      owned.current = result.control;
      setLease(result.control); setHolder(result.control);
      setMessage(result.control ? "" : "Control was not granted. Refresh and try again.");
    } catch (error) {
      if (mounted.current && revision === generation.current) {
        if (!(reconnecting.current && owned.current && !isControlRefusal(error))) {
          forget();
          if (isControlRefusal(error) && error.control !== undefined) setHolder(error.control);
        }
        setMessage((error as Error).message);
      }
    } finally { claiming.current = false; if (mounted.current) setBusy(false); }
  };
  const release = async () => {
    const previous = owned.current;
    if (!previous || claiming.current) return;
    forget(false);
    const revision = generation.current;
    claiming.current = true;
    setBusy(true);
    try {
      await api(`/sessions/${id}/control`, { action: "release", leaseId: previous.id });
    } catch {
      releaseRequest(previous);
      if (mounted.current && revision === generation.current)
        setMessage("Control release was not confirmed. This device stopped sending; release will retry when online.");
    } finally {
      // Discard polls begun before the host acknowledged the release.
      if (revision === generation.current) generation.current++;
      claiming.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      const previous = owned.current;
      owned.current = null;
      reconnecting.current = false;
      if (previous) releaseRequest(previous);
    };
  }, [id]);
  useEffect(() => {
    if (!lease) return;
    let renewing = false;
    const expire = setTimeout(() => {
      if (owned.current?.id === lease.id) {
        reconnecting.current = true;
        if (foreground()) void claim();
      }
    }, Math.max(0, lease.expiresAt - Date.now()));
    const renew = async () => {
      if (renewing || !foreground() || owned.current?.id !== lease.id) return;
      renewing = true;
      const revision = generation.current;
      try {
        const result = await api<{ control: ControlLease | null }>(`/sessions/${id}/control`, { action: "renew", leaseId: lease.id });
        if (mounted.current && revision === generation.current && owned.current?.id === lease.id) {
          if (result.control?.id === lease.id && foreground()) {
            generation.current++;
            reconnecting.current = false;
            owned.current = result.control; setLease(result.control); setHolder(result.control);
          } else {
            reconnecting.current = true;
            if (foreground()) void claim();
          }
        }
      } catch {
        if (mounted.current && revision === generation.current) {
          reconnecting.current = true;
          if (foreground()) void claim();
        }
      } finally { renewing = false; }
    };
    const resume = () => { if (reconnecting.current) void claim(); else void renew(); };
    const timer = setInterval(resume, 10000);
    // A tab returning to the foreground renews or reclaims at once rather than waiting out the interval.
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
