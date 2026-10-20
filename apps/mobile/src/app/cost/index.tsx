import { ConnectedScreen } from "../../components/ConnectedScreen";
import { CostOverview } from "../../features/cost/CostOverview";

export default function CostRoute() {
  return <ConnectedScreen missing="Pair a machine to see its cost." render={connection => <CostOverview connection={connection} />} />;
}
