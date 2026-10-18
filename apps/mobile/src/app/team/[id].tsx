import { SessionGate } from "../../features/session/SessionGate";
import { TeamDetail } from "../../features/teams/TeamDetail";

export default function TeamRoute() {
  return <SessionGate render={(connection, id) => <TeamDetail connection={connection} id={id} />} />;
}
