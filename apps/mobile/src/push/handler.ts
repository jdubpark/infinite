import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import { loadConnections } from "../store/connection";
import { connectionKey } from "../api/client";
import { router } from "expo-router";

export function installNotificationHandler() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

async function redirect(n: Notifications.Notification) {
  const data = n.request.content.data;
  const url = data?.url;
  if (typeof url !== "string") return;
  const [, kind, id] = url.match(/^\/(session|team|goal)\/([a-f0-9-]{36})(?:\?.*)?$/i) ?? [];
  const topLevel = !kind && /^\/(teams|machine)(?:\?.*)?$/i.test(url);
  if ((!kind || !id) && !topLevel) return;
  const saved = await loadConnections();
  const machineId = typeof data?.machineId === "string" ? data.machineId : undefined;
  const connection = machineId ? saved.profiles.find(profile => profile.id === machineId || profile.machineId === machineId || profile.relay?.machineId === machineId) : saved.profiles.length === 1 ? saved.profiles[0] : undefined;
  if (!connection) { router.push("/"); return; }
  if (topLevel) { router.push({ pathname: "/(tabs)", params: { machine: connectionKey(connection) } }); return; }
  const pathname = kind!.toLowerCase() === "team" ? "/team/[id]" : kind!.toLowerCase() === "goal" ? "/goal/[id]" : "/session/[id]";
  router.push({ pathname, params: { id: id!, machine: connectionKey(connection) } });
}

export function useNotificationRouting() {
  useEffect(() => {
    const last = Notifications.getLastNotificationResponse();
    if (last?.notification) void redirect(last.notification).catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((r) =>
      void redirect(r.notification).catch(() => {}),
    );
    return () => sub.remove();
  }, []);
}
