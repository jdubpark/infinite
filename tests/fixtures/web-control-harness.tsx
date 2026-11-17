// The web client's control lease hook against a stand-in host. tests/web-polling.test.ts claims a lease through `window.control`
// and counts the renewals it sends.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ApiContext, ApiError, type Api, type ControlLease } from "../../apps/web/src/api";
import { useLiveRefresh } from "../../apps/web/src/live-refresh";
import { useSessionControl } from "../../apps/web/src/session-control";

type ControlCall = { action?: string; leaseId?: string; takeover?: boolean };
const control = {
  calls: [] as ControlCall[], renewals: 0, claims: 0, releaseRequests: 0,
  held: null as ControlLease | null, holder: null as ControlLease | null, hostHeld: null as ControlLease | null,
  ready: false, holdRenew: false, rejectRenew: undefined as (() => void) | undefined,
  refuseClaims: false, leaseMs: 30_000, claim: () => {}, teardown: () => {},
};
Object.assign(window, { control });
const lease = (id: string): ControlLease => ({ id, label: "This browser", expiresAt: Date.now() + control.leaseMs });

const host = (async (path: string, body?: ControlCall) => {
  if (path !== "/sessions/s1/control") throw new Error(`Unexpected request: ${path}`);
  control.calls.push(body ?? {});
  if (body?.action === "claim") {
    control.claims++;
    if (control.refuseClaims) {
      control.hostHeld = lease("other-lease");
      throw new ApiError("Control is held by another device", 409, "control-busy", control.hostHeld);
    }
    control.hostHeld = lease(`lease-${control.claims}`);
    return { control: control.hostHeld };
  }
  if (body?.action === "renew") {
    control.renewals++;
    if (control.holdRenew) return new Promise((_, reject) => { control.rejectRenew = () => reject(new TypeError("offline")); });
    if (control.hostHeld?.id === body.leaseId) {
      control.hostHeld = { ...control.hostHeld, expiresAt: Date.now() + control.leaseMs };
      return { control: control.hostHeld };
    }
    return { control: null };
  }
  if (body?.action === "release") {
    control.releaseRequests++;
    if (!navigator.onLine) throw new TypeError("offline");
    if (control.hostHeld?.id !== body.leaseId) throw new ApiError("Control lease is no longer held", 409, "control-lost");
    control.hostHeld = null;
    return {};
  }
  throw new Error("Unexpected control action");
}) as unknown as Api;

function Probe() {
  const session = useSessionControl("s1");
  useLiveRefresh(async () => {}, 10000, "s1", session.unavailable);
  useEffect(() => {
    control.claim = () => { void session.claim(); };
    control.held = session.lease;
    control.holder = session.holder;
    control.ready = true;
  });
  return <><strong>{session.lease ? "You have control" : "Monitoring"}</strong>
    <button>{session.lease ? "Stop controlling" : session.holder ? "Take over" : "Take control"}</button></>;
}

const root = createRoot(document.getElementById("root")!);
control.teardown = () => root.unmount();
root.render(<ApiContext.Provider value={host}><Probe /></ApiContext.Provider>);
