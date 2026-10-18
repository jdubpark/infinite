import { SessionGate } from "../../features/session/SessionGate";
import { GoalDetail } from "../../features/teams/GoalDetail";

export default function GoalRoute() {
  return <SessionGate render={(connection, id) => <GoalDetail connection={connection} id={id} />} />;
}
