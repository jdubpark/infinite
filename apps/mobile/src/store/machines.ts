import { useEffect, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { closeConnection, connectionKey, type Connection } from "../api/client";
import { clearDrafts } from "./drafts";
import { clearConnection, loadConnections, selectConnection, useConnections } from "./connection";
import { creations, goalCreations, lifecycles, missionCreations, runRequests, teamCreations } from "./requests";

/** Invalidates one pairing across tabs and all machine-scoped in-memory state. */
export function forgetMachine(connection: Connection) {
  const key = connectionKey(connection);
  closeConnection(connection);
  clearDrafts(key);
  creations.clear(key);
  lifecycles.clearMachine(key);
  teamCreations.clearMachine(key);
  goalCreations.clearMachine(key);
  missionCreations.clearMachine(key);
  runRequests.clearMachine(key);
  return clearConnection(key);
}

/**
 * The machine every tab shows. The tabs share one selection in the machines store, so switching in
 * one tab switches the others. A route's `machine` param (after pairing, or a back link from a
 * detail screen) becomes that shared selection and then leaves the route, so no tab keeps a
 * private choice. With no pairings left, the tab goes to pairing.
 */
export function useSharedMachine() {
  const router = useRouter();
  const { machine } = useLocalSearchParams<{ machine?: string }>();
  const saved = useConnections();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    loadConnections().then(current => {
      if (live && !current.profiles.length) router.replace("/pair");
    }).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [router]);
  useEffect(() => {
    if (!machine) return;
    let live = true;
    loadConnections()
      .then(current => current.active !== machine && current.profiles.some(profile => connectionKey(profile) === machine) ? selectConnection(machine) : undefined)
      .catch(() => {})
      .finally(() => { if (live) router.setParams({ machine: undefined }); });
    return () => { live = false; };
  }, [machine, router]);
  // Until the param is promoted, show the requested machine so the tab does not flash the old one.
  const active = machine && saved.profiles.some(profile => connectionKey(profile) === machine) ? machine : saved.active;
  const connection = saved.profiles.find(profile => connectionKey(profile) === active) ?? null;
  return { loaded, active, connection, profiles: saved.profiles, select: selectConnection };
}
