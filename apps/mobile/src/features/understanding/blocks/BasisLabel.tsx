import { Text } from "react-native";
import type { Basis } from "@infinite/remote";
import { styles } from "./styles";

const LABELS: Record<Basis, string> = {
  source: "Source",
  agent: "Agent report",
  owner: "Owner",
  model: "Model",
  host: "Host",
};

/** Names who said the text beside it, so the honesty boundary is visible on every card. */
export function BasisLabel({ basis }: { basis: Basis }) {
  return <Text style={styles.basis}>{LABELS[basis]}</Text>;
}
