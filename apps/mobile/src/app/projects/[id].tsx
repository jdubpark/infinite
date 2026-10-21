import { useLocalSearchParams } from "expo-router";
import { ConnectedScreen } from "../../components/ConnectedScreen";
import { ProjectDetail } from "../../features/projects/ProjectDetail";

export default function ProjectRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ConnectedScreen missing="Pair a machine to manage this project." render={connection => id ? <ProjectDetail connection={connection} id={id} /> : null} />;
}
