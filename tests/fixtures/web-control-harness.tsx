// The web client's control lease hook against a stand-in host. tests/web-polling.test.ts claims a lease through `window.control`
// and counts the renewals it sends.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ApiContext, type Api, type ControlLease } from "../../apps/web/src/api";
import { useSessionControl } from "../../apps/web/src/session-control";

const control = { renewals: 0, held: null as ControlLease | null, claim: () => {} };
Object.assign(window, { control });
const lease = (): ControlLease => ({ id: "lease-1", label: "This browser", expiresAt: Date.now() + 30_000 });

const host = (async (path: string, body?: { action?: string }) => {
  if (path !== "/sessions/s1/control") throw new Error(`Unexpected request: ${path}`);
  if (body?.action === "renew") control.renewals++;
  return body?.action === "release" ? {} : { control: lease() };
}) as unknown as Api;

function Probe() {
  const session = useSessionControl("s1");
  useEffect(() => { control.claim = () => { void session.claim(); }; control.held = session.lease; });
  return null;
}

createRoot(document.getElementById("root")!).render(<ApiContext.Provider value={host}><Probe /></ApiContext.Provider>);
