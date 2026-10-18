import { ConnectedScreen } from "../../components/ConnectedScreen";
import { TeamCreate } from "../../features/teams/TeamCreate";

export default function NewTeam() {
  return <ConnectedScreen missing="Connect this machine before starting a team."
    render={(connection, machine) => <TeamCreate key={machine} connection={connection} />} />;
}
