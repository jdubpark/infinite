import { SessionGate } from "../../../features/session/SessionGate";
import { Terminal } from "../../../features/session/Terminal";

export default function TerminalRoute() {
  return (
    <SessionGate
      render={(connection, id) => (
        <Terminal connection={connection} id={id} backLabel="Back" />
      )}
    />
  );
}
