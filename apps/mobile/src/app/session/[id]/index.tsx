import { Brief } from "../../../features/session/Brief";
import { SessionGate } from "../../../features/session/SessionGate";

export default function BriefRoute() {
  return (
    <SessionGate
      render={(connection, id) => <Brief connection={connection} id={id} />}
    />
  );
}
