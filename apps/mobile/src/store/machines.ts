import { useEffect, useRef, useState } from "react";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { closeConnection, connectionKey, type Connection } from "../api/client";
import { clearDrafts } from "./drafts";
import { clearConnection, loadConnections, selectConnection, useConnections } from "./connection";
import { creations, goalCreations, lifecycles, missionCreations, runRequests, teamCreations } from "./requests";

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

export function useSharedMachine() {
  const router = useRouter();
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
        if (generation.current !== run) return;
        setPromoted(machine);
        navigation.setParams({ machine: undefined });
      });
    return () => { generation.current += 1; };
  }, [machine, navigation]);
  if (!machine && promoted !== undefined) setPromoted(undefined);
  const requested = machine && machine !== promoted && saved.profiles.some(profile => connectionKey(profile) === machine) ? machine : undefined;
  const active = requested ?? saved.active;
  const connection = saved.profiles.find(profile => connectionKey(profile) === active) ?? null;
  return { loaded, active, connection, profiles: saved.profiles, select: selectConnection };
}
