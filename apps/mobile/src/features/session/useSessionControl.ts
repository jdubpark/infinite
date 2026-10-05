import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  api,
  type Connection,
  type ControlLease,
  type SessionRow,
} from "../../api/client";

/** The host's lease lasts 30 s; renewing every 10 s keeps it while the phone is in use. */
const RENEW_MS = 10_000;

type ControlState = {
  /** The lease this phone holds, or null. */
  lease: ControlLease | null;
  /** The lease the host last reported, whichever device holds it. */
  holder: ControlLease | null;
  message: string;
  busy: boolean;
};

const sameLease = (a: ControlLease | null, b: ControlLease | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.id === b.id &&
    a.label === b.label &&
    a.expiresAt === b.expiresAt);

/**
 * One session's input lease on this phone. The Brief and Terminal routes share it, so moving
 * between them keeps control. It is released when neither route is focused, when the app
 * leaves the foreground, or when a screen stops reaching the host. Nothing reacquires it
 * without the person asking.
 */
class SessionControl {
  private state: ControlState = {
    lease: null,
    holder: null,
    message: "",
    busy: false,
  };
  private listeners = new Set<() => void>();
  /** Bumped by every local change, so a poll that started earlier cannot undo it. */
  private revision = 0;
  private focused = 0;
  private claiming = false;
  private renewing = false;
  private renewTimer: ReturnType<typeof setInterval> | undefined;
  private expireTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly id: string,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  generation = () => this.revision;
  leaseId = () => this.state.lease?.id;

  private set(patch: Partial<ControlState>) {
    const next = { ...this.state, ...patch };
    if (
      sameLease(next.lease, this.state.lease) &&
      sameLease(next.holder, this.state.holder) &&
      next.message === this.state.message &&
      next.busy === this.state.busy
    )
      return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private active() {
    return this.focused > 0 && AppState.currentState === "active";
  }

  private release(lease: ControlLease) {
    void api(this.connection, `/sessions/${this.id}/control`, {
      body: { action: "release", leaseId: lease.id },
    }).catch(() => {});
  }

  private hold(lease: ControlLease | null) {
    clearInterval(this.renewTimer);
    clearTimeout(this.expireTimer);
    this.set(lease ? { lease, holder: lease } : { lease: null });
    if (!lease) return;
    this.expireTimer = setTimeout(
      () => this.forget(),
      Math.max(0, lease.expiresAt - Date.now()),
    );
    this.renewTimer = setInterval(() => void this.renew(), RENEW_MS);
  }

  /** Drops the local lease; `release` also tells the host so another device can take over. */
  forget = (release = false) => {
    this.revision++;
    const previous = this.state.lease;
    this.hold(null);
    if (!previous) return;
    this.set({
      message: "Monitoring. Take control again when you are ready to send input.",
    });
    if (release) this.release(previous);
  };

  /** The host refused input for control: this phone no longer holds a lease there. */
  refused = () => this.forget();

  /** Takes in a poll of the session that started at `revision`. */
  observe = (session: SessionRow, revision: number) => {
    if (revision !== this.revision) return;
    const control = session.control ?? null;
    this.set({ holder: control });
    const held = this.state.lease;
    if (
      held &&
      (control?.id !== held.id ||
        control.expiresAt <= Date.now() ||
        session.status !== "running")
    )
      this.forget();
  };

  claim = async (takeover = false) => {
    if (this.claiming) return;
    this.claiming = true;
    const revision = ++this.revision;
    this.set({ busy: true, message: "" });
    try {
      const result = await api<{ control: ControlLease | null }>(
        this.connection,
        `/sessions/${this.id}/control`,
        { body: { action: "claim", ...(takeover ? { takeover: true } : {}) } },
      );
      if (!this.active() || revision !== this.revision) {
        // The person left the session or the app while the claim was in flight.
        if (result.control) this.release(result.control);
        return;
      }
      // Polls that started while this claim was awaiting its answer must not revoke it.
      this.revision++;
      this.hold(result.control);
      this.set({
        message: result.control
          ? "This phone has control."
          : "Control was not granted. Refresh and try again.",
      });
    } catch (error) {
      if (this.active() && revision === this.revision) {
        this.forget();
        this.set({ message: (error as Error).message });
      }
    } finally {
      this.claiming = false;
      this.set({ busy: false });
    }
  };

  private async renew() {
    const held = this.state.lease;
    if (this.renewing || !held || !this.active()) return;
    this.renewing = true;
    const revision = this.revision;
    try {
      const result = await api<{ control: ControlLease | null }>(
        this.connection,
        `/sessions/${this.id}/control`,
        { body: { action: "renew", leaseId: held.id } },
      );
      if (revision !== this.revision || this.state.lease?.id !== held.id) return;
      if (result.control?.id === held.id && this.active()) {
        this.revision++;
        this.hold(result.control);
      } else this.forget();
    } catch {
      if (revision === this.revision) this.forget();
    } finally {
      this.renewing = false;
    }
  }

  /** Counts a focused route; the lease is released once no route of this session is focused. */
  focus = () => {
    this.focused++;
    return () => {
      this.focused--;
      // Moving between the Brief and the Terminal blurs one route as the other gains focus.
      setTimeout(() => {
        if (this.focused === 0) this.forget(true);
      }, 0);
    };
  };

  /** Leaving the foreground releases control; returning only refreshes. */
  appState = () => {
    if (AppState.currentState !== "active") this.forget(true);
  };
}

const controls = new Map<string, SessionControl>();
function controlFor(connection: Connection, id: string) {
  const key = `${connection.url}\n${connection.token}\n${id}`;
  let control = controls.get(key);
  if (!control) {
    control = new SessionControl(connection, id);
    controls.set(key, control);
  }
  return control;
}

/**
 * This phone's input control for one session: claim, explicit takeover, renewal while the
 * session is on screen, and release. Input calls read `leaseId()` when they send.
 */
export function useSessionControl(connection: Connection, id: string) {
  const control = controlFor(connection, id);
  const state = useSyncExternalStore(control.subscribe, control.snapshot);
  useFocusEffect(useCallback(() => control.focus(), [control]));
  useEffect(() => {
    const listener = AppState.addEventListener("change", control.appState);
    return () => listener.remove();
  }, [control]);
  return {
    ...state,
    claim: control.claim,
    forget: control.forget,
    refused: control.refused,
    observe: control.observe,
    generation: control.generation,
    leaseId: control.leaseId,
  };
}

export type SessionControlHandle = ReturnType<typeof useSessionControl>;

/**
 * Feeds one screen's session polls to the control: the holder shown is the host's, and a lease
 * the host no longer reports is dropped. When this screen stops reaching the host, the lease is
 * released: a stale view never keeps input control.
 */
export function useControlSync(
  control: SessionControlHandle,
  poll: { session: SessionRow; revision: number } | null,
  online: boolean,
) {
  const { observe, forget } = control;
  useEffect(() => {
    if (poll) observe(poll.session, poll.revision);
  }, [observe, poll]);
  const wasOnline = useRef(false);
  useEffect(() => {
    if (wasOnline.current && !online) forget(true);
    wasOnline.current = online;
  }, [forget, online]);
}
