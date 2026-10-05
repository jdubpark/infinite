import { useEffect } from "react";
import * as Notifications from "expo-notifications";
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

function redirect(n: Notifications.Notification) {
  const url = n.request.content.data?.url;
  if (typeof url === "string" && url.startsWith("/session/"))
    router.push(url as never);
}

export function useNotificationRouting() {
  useEffect(() => {
    const last = Notifications.getLastNotificationResponse();
    if (last?.notification) redirect(last.notification);
    const sub = Notifications.addNotificationResponseReceivedListener((r) =>
      redirect(r.notification),
    );
    return () => sub.remove();
  }, []);
}
