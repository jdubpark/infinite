import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";
import { inForeground, onForegroundChange } from "../../api/foreground";
import {
  api,
  ControlRefusal,
  type Connection,
  type ControlLease,
  type SessionRow,
} from "../../api/client";

const RENEW_MS = 10_000;

type ControlState = {
  lease: ControlLease | null;
  holder: ControlLease | null;
  message: string;
  busy: boolean;
};

type LeasePhase =
  | { kind: "unheld" }
  | { kind: "claiming"; token: number; lease: ControlLease | null }
  | { kind: "held"; lease: ControlLease; renewing: boolean; renewOnForeground: boolean }
  | { kind: "releasing"; lease: ControlLease };

const sameLease = (a: ControlLease | null, b: ControlLease | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.id === b.id &&
    a.label === b.label &&
    a.expiresAt === b.expiresAt);

class SessionControl {
  private state: ControlState = {
    lease: null,
    holder: null,
    message: "",
    busy: false,
  };
  private phase: LeasePhase = { kind: "unheld" };
  private listeners = new Set<() => void>();
  private revision = 0;
  private opToken = 0;
  private focused = 0;
  private renewTimer: ReturnType<typeof setInterval> | undefined;
  private expireTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly id: string,
    private readonly onUnused: () => void,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.collect();
    };
  };
  snapshot = () => this.state;
  generation = () => this.revision;

  private currentLease(): ControlLease | null {
    if (this.phase.kind === "held" || this.phase.kind === "claiming") return this.phase.lease;
    return null;
  }

  leaseId = () => {
    const lease = this.currentLease();
    if (lease && lease.expiresAt <= Date.now()) {
      this.forget();
      return undefined;
    }
    return lease?.id;
  };

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

  private collect() {
    const idle =
      this.phase.kind === "unheld" ||
      this.phase.kind === "releasing";
    if (!this.listeners.size && this.focused === 0 && idle)
      this.onUnused();
  }

  private active() {
    return this.focused > 0 && inForeground();
  }

  private clearTimers() {
    clearInterval(this.renewTimer);
    clearTimeout(this.expireTimer);
    this.renewTimer = undefined;
    this.expireTimer = undefined;
  }

  private release(lease: ControlLease) {
    return api(this.connection, `/sessions/${this.id}/control`, {
      body: { action: "release", leaseId: lease.id },
    }).catch(() => {});
  }

  private hold(lease: ControlLease | null) {
    this.clearTimers();
    if (!lease) {
      this.phase = { kind: "unheld" };
      this.set({ lease: null });
      return;
    }
    this.phase = { kind: "held", lease, renewing: false, renewOnForeground: false };
    this.set({ lease, holder: lease });
    this.expireTimer = setTimeout(
      () => this.forget(),
      Math.max(0, lease.expiresAt - Date.now()),
    );
    if (inForeground())
      this.renewTimer = setInterval(() => void this.renew(), RENEW_MS);
  }

  forget = (release = false) => {
    this.revision++;
    const previous = this.currentLease();
    this.clearTimers();
    if (release && previous) {
      this.phase = { kind: "releasing", lease: previous };
      this.set({ lease: null });
      void this.release(previous).finally(() => {
        if (this.phase.kind === "releasing" && this.phase.lease.id === previous.id) {
          this.phase = { kind: "unheld" };
          this.collect();
        }
      });
    } else {
      this.phase = { kind: "unheld" };
      this.set({ lease: null });
    }
    this.collect();
  };

  dismiss = () => this.set({ message: "" });

  refused = () => this.forget();

  observe = (session: SessionRow, revision: number) => {
    if (revision !== this.revision) return;
    const control = session.control ?? null;
    this.set({ holder: control });
    const held = this.currentLease();
    if (
      held &&
      (control?.id !== held.id ||
        control.expiresAt <= Date.now() ||
        session.status !== "running")
    )
      this.forget();
  };

  claim = async (takeover = false) => {
    if (this.phase.kind === "claiming") return;
    const prior = this.currentLease();
    const token = ++this.opToken;
    this.phase = { kind: "claiming", token, lease: prior };
    const revision = ++this.revision;
    this.set({ busy: true, message: "" });
    try {
      const result = await api<{ control: ControlLease | null }>(
        this.connection,
        `/sessions/${this.id}/control`,
        { body: { action: "claim", ...(takeover ? { takeover: true } : {}) } },
      );
      if (this.focused === 0 || revision !== this.revision) {
        if (result.control) void this.release(result.control);
        return;
      }
      this.revision++;
      this.hold(result.control);
      this.set({ message: result.control ? "" : "Control was not granted. Refresh and try again." });
    } catch (error) {
      if (this.active() && revision === this.revision) {
        this.forget();
        this.set({ message: (error as Error).message });
      }
    } finally {
      if (this.phase.kind === "claiming" && this.phase.token === token) {
        this.phase = prior
          ? { kind: "held", lease: prior, renewing: false, renewOnForeground: false }
          : { kind: "unheld" };
      }
      if (this.phase.kind !== "claiming") this.set({ busy: false });
      this.collect();
    }
  };

  private async renew() {
    if (this.phase.kind !== "held") return;
    const held = this.phase.lease;
    if (held.expiresAt <= Date.now()) {
      this.forget();
      return;
    }
    if (this.phase.renewing) {
      if (this.active()) this.phase.renewOnForeground = true;
      return;
    }
    if (!this.active()) return;
    this.phase.renewing = true;
    const revision = this.revision;
    let renewed = false;
    try {
      const result = await api<{ control: ControlLease | null }>(
        this.connection,
        `/sessions/${this.id}/control`,
        { body: { action: "renew", leaseId: held.id } },
      );
      if (revision !== this.revision || this.phase.kind !== "held" || this.phase.lease.id !== held.id) return;
      if (result.control?.id === held.id) {
        this.revision++;
        this.hold(result.control);
        renewed = true;
      } else this.forget();
    } catch {
      if (
        revision === this.revision &&
        this.active() &&
        this.phase.kind === "held" &&
        !this.phase.renewOnForeground
      )
        this.forget();
    } finally {
      if (this.phase.kind === "held" && this.phase.lease.id === held.id) {
        const retry = this.phase.renewOnForeground;
        this.phase.renewing = false;
        this.phase.renewOnForeground = false;
        if (retry && !renewed && this.active()) void this.renew();
      }
      this.collect();
    }
  }

  focus = () => {
    this.focused++;
    return () => {
      this.focused--;
      setTimeout(() => {
        if (this.focused === 0) this.forget(true);
      }, 0);
    };
  };

  foreground = (foreground: boolean) => {
    if (!foreground) {
      clearInterval(this.renewTimer);
      this.renewTimer = undefined;
      return;
    }
    if (this.phase.kind !== "held") return;
    if (this.phase.lease.expiresAt <= Date.now()) {
      this.forget();
      return;
    }
    void this.renew();
  };
}

const controls = new Map<string, SessionControl>();
function controlFor(connection: Connection, id: string) {
  const key = `${connection.url}\n${connection.token}\n${id}`;
  let control = controls.get(key);
  if (!control) {
    control = new SessionControl(connection, id, () => {
      if (controls.get(key) === control) controls.delete(key);
    });
    controls.set(key, control);
  }
  return control;
}

export function useSessionControl(connection: Connection, id: string) {
  const control = controlFor(connection, id);
  const state = useSyncExternalStore(control.subscribe, control.snapshot);
  useFocusEffect(useCallback(() => control.focus(), [control]));
  useEffect(() => {
    return onForegroundChange(control.foreground);
  }, [control]);
  return {
    ...state,
    claim: control.claim,
    forget: control.forget,
    dismiss: control.dismiss,
    refused: control.refused,
    observe: control.observe,
    generation: control.generation,
    leaseId: control.leaseId,
  };
}

export type SessionControlHandle = ReturnType<typeof useSessionControl>;

export function leaseFor(
  control: Pick<SessionControlHandle, "leaseId">,
  requiresControl: boolean,
): string | undefined {
  const lease = control.leaseId();
  if (requiresControl && lease === undefined)
    throw new ControlRefusal(
      "Control changed or expired. Take control again before sending.",
      "control-lost",
    );
  return lease;
}

export function useControlSync(
  control: SessionControlHandle,
  poll: { session: SessionRow; revision: number } | null,
  stale: boolean,
) {
  const { observe, forget } = control;
  useEffect(() => {
    if (poll) observe(poll.session, poll.revision);
  }, [observe, poll]);
  useEffect(() => {
    if (stale) forget(true);
  }, [forget, stale]);
}
