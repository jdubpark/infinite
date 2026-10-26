import test from "node:test";
import assert from "node:assert/strict";
import { inProcessHost } from "./helpers.js";

test("starting the host attaches no more server listeners than Node allows before warning", { timeout: 30000 }, async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => { warnings.push(`${warning.name}: ${warning.message}`); };
  process.on("warning", onWarning);
  const host = await inProcessHost();
  try {
    // Node emits MaxListenersExceededWarning on a later tick, so give it one before reading the list.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(warnings.filter(w => w.startsWith("MaxListenersExceededWarning")), [], "host start must not trip the listener limit");
    for (const event of ["listening", "close"] as const)
      assert.ok(host.server.listenerCount(event) <= host.server.getMaxListeners(), `${event} listeners stay within the limit`);
  } finally {
    process.off("warning", onWarning);
    await host.stop();
  }
});
