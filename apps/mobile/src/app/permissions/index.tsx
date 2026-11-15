import { ConnectedScreen } from "../../components/ConnectedScreen";
import { PermissionLog } from "../../features/permissions/PermissionLog";

export default function PermissionLogRoute() {
  return <ConnectedScreen missing="Pair a machine to see its permission decisions." render={connection => <PermissionLog connection={connection} />} />;
}
