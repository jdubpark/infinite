import { ConnectedScreen } from "../../components/ConnectedScreen";
import { GoalCreate } from "../../features/teams/GoalCreate";

export default function NewGoal() {
  return <ConnectedScreen missing="Connect this machine before starting a goal."
    render={(connection, machine) => <GoalCreate key={machine} connection={connection} />} />;
}
