import { ConnectedScreen } from "../components/ConnectedScreen";
import { DecisionQueueScreen } from "../features/queue/DecisionQueueScreen";

export default function DecisionsRoute() {
  return <ConnectedScreen missing="Pair a machine to answer its decisions."
    render={(connection, machine) => <DecisionQueueScreen key={machine} connection={connection} />} />;
}
