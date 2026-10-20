import { useEffect, useRef, useState } from "react";
import { isControlRefusal, useApi, type ControlLease, type Session } from "./api";
import { foreground } from "./live-refresh";

export function useSessionControl(id: string) {
  const api = useApi();
  const [lease, setLease] = useState<ControlLease | null>(null);
  const [holder, setHolder] = useState<ControlLease | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const owned = useRef<ControlLease | null>(null);
  const claiming = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const releaseRequest = (control: ControlLease) => api(`/sessions/${id}/control`, {
    action: "release", leaseId: control.id,
  }).catch(() => {});
  const forget = (release = false) => {
    generation.current++;
    const previous = owned.current;
    owned.current = null;
    setLease(null);
    if (previous) {
      setHolder(current => current?.id === previous.id ? null : current);
      setMessage("");
      if (release) void releaseRequest(previous);
    }
  };
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
      owned.current = result.control;
      setLease(result.control); setHolder(result.control);
      setMessage(result.control ? "" : "Control was not granted. Refresh and try again.");
    } catch (error) {
      if (mounted.current && revision === generation.current) {
        forget();
        if (isControlRefusal(error) && error.control !== undefined) setHolder(error.control);
        setMessage((error as Error).message);
      }
    } finally { claiming.current = false; if (mounted.current) setBusy(false); }
  };
  const release = async () => {
    const previous = owned.current;
    if (!previous || claiming.current) return;
    forget();
    const revision = generation.current;
    claiming.current = true;
    setBusy(true);
    try {
      await api(`/sessions/${id}/control`, { action: "release", leaseId: previous.id });
    } catch {
      if (mounted.current && revision === generation.current)
        setMessage("Control release was not confirmed. This device stopped sending; the host lease will expire.");
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
      if (previous) void api(`/sessions/${id}/control`, { action: "release", leaseId: previous.id }).catch(() => {});
    };
  }, [id]);
  useEffect(() => {
    if (!lease) return;
    let renewing = false;
    const expire = setTimeout(() => forget(), Math.max(0, lease.expiresAt - Date.now()));
    const renew = async () => {
      if (renewing || !foreground() || owned.current?.id !== lease.id) return;
      renewing = true;
      const revision = generation.current;
      try {
        const result = await api<{ control: ControlLease | null }>(`/sessions/${id}/control`, { action: "renew", leaseId: lease.id });
        if (mounted.current && revision === generation.current && owned.current?.id === lease.id) {
          if (result.control?.id === lease.id && foreground()) {
            generation.current++;
            owned.current = result.control; setLease(result.control); setHolder(result.control);
          } else forget();
        }
      } catch {
        if (mounted.current && revision === generation.current) forget();
      } finally { renewing = false; }
    };
    const timer = setInterval(renew, 10000);
    // A tab returning to the foreground renews at once rather than waiting out the interval.
    const resume = () => { void renew(); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      clearTimeout(expire); clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, [id, lease]);
  return { lease, holder, message, busy, claim, release, forget, observe, generation, owned };
}
