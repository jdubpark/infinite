import { SessionGate } from "../../../features/session/SessionGate";
import { ProjectCost } from "../../../features/cost/ProjectCost";

export default function ProjectCostRoute() {
  return <SessionGate render={(connection, id) => <ProjectCost connection={connection} id={id} />} />;
}
