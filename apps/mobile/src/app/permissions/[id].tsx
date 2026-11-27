import { SessionGate } from "../../features/session/SessionGate";
import { PermissionDecision } from "../../features/permissions/PermissionDecision";

export default function PermissionDecisionRoute() {
  return <SessionGate render={(connection, id) => <PermissionDecision connection={connection} id={id} />} />;
}
