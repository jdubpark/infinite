// The web client's decision queue view with its feed, wired as the app wires them, against the page's own /api routes.
// tests/web-decision-view.test.ts answers those routes and records what the view sends.
import { createRoot } from "react-dom/client";
import { postDecisionAnswer, useApi, type Me } from "../../apps/web/src/api";
import { DecisionQueueView } from "../../apps/web/src/decision-queue";
import { useDecisionQueueFeed } from "../../apps/web/src/decision-queue-feed";
import { MachineProvider } from "../../apps/web/src/machines";

const settings = (window as unknown as { decisionView?: { role?: Me["role"]; interval?: number } }).decisionView ?? {};
const role = settings.role ?? "owner";

function Probe() {
  const api = useApi();
  const feed = useDecisionQueueFeed(api, `direct:${role}`, settings.interval ?? 300);
  return <DecisionQueueView queue={feed.queue} readAt={feed.readAt} current={feed.current} stale={feed.stale} failed={feed.failed}
    failureSince={feed.failureSince} unavailable={feed.unavailable} role={role} promptAnswers projects={[]} refresh={feed.refresh}
    confirmAnswered={feed.confirmAnswered} navigateSession={() => {}}
    answer={async (decision, request) => { await postDecisionAnswer(api, decision.answerPath, request); }} />;
}

createRoot(document.getElementById("root")!).render(<MachineProvider><Probe /></MachineProvider>);
