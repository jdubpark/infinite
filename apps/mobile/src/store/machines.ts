import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
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
 * detail screen) becomes that shared selection and is then cleared from the route that carries it,
 * so no tab keeps a private choice. With no pairings left, the tab goes to pairing.
 */
export function useSharedMachine() {
  const router = useRouter();
  // This screen's own navigation: the global router would clear the param on whichever tab is focused.
  const navigation = useNavigation<{ setParams(params: { machine?: string }): void }>();
  const { machine } = useLocalSearchParams<{ machine?: string }>();
  const saved = useConnections();
  const [loaded, setLoaded] = useState(false);
  const [promoted, setPromoted] = useState<string>();
  const generation = useRef(0);
  useEffect(() => {
    let live = true;
    loadConnections().then(current => {
      if (live && !current.profiles.length) router.replace("/pair");
    }).finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [router]);
  useEffect(() => {
    if (!machine) return;
    const run = ++generation.current;
    loadConnections()
      .then(current => current.active !== machine && current.profiles.some(profile => connectionKey(profile) === machine) ? selectConnection(machine) : undefined)
      .catch(() => {})
      .finally(() => {
        // A newer param, or this screen unmounting, supersedes this promotion; it must not clear that param.
        if (generation.current !== run) return;
        setPromoted(machine);
        navigation.setParams({ machine: undefined });
      });
    return () => { generation.current += 1; };
  }, [machine, navigation]);
  if (!machine && promoted !== undefined) setPromoted(undefined);
  // Until the param is promoted, show the requested machine so the tab does not flash the old one.
  // Once promoted, the store decides, even if clearing the param has not landed yet.
  const requested = machine && machine !== promoted && saved.profiles.some(profile => connectionKey(profile) === machine) ? machine : undefined;
  const active = requested ?? saved.active;
  const connection = saved.profiles.find(profile => connectionKey(profile) === active) ?? null;
  return { loaded, active, connection, profiles: saved.profiles, select: selectConnection };
}
