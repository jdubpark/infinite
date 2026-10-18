import { ConnectedScreen } from "../components/ConnectedScreen";
import { Create } from "../features/create/Create";

export default function NewSession() {
  return <ConnectedScreen missing="Connect this machine before creating a session."
    render={(connection, machine) => <Create key={machine} connection={connection} />} />;
}
