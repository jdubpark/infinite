import { ConnectedScreen } from "../../components/ConnectedScreen";
import { ProjectsList } from "../../features/projects/ProjectsList";

export default function ProjectsRoute() {
  return <ConnectedScreen missing="Pair a machine to manage projects." render={connection => <ProjectsList connection={connection} />} />;
}
