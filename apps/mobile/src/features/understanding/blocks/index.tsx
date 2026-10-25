import { Text, View } from "react-native";
import type { WorkBlock } from "@infinite/remote";
import { Checks } from "./Checks";
import { Citations } from "./Citations";
import { Components } from "./Components";
import { Decisions } from "./Decisions";
import { Facts } from "./Facts";
import { Links } from "./Links";
import { Note } from "./Note";
import { Questions } from "./Questions";
import { RichText } from "./RichText";
import { Tasks } from "./Tasks";
import { styles } from "./styles";

export { RichText } from "./RichText";

/** Renders one block of a work brief. Each block shows its own basis labels. */
export function BlockView({ block, onOpenComponent, onOpenWork }: { block: WorkBlock; onOpenComponent?: (componentId: string) => void; onOpenWork?: (workId: string) => void }) {
  switch (block.kind) {
    case "facts":
      return <Facts items={block.items} />;
    case "rich":
      return <RichText nodes={block.nodes} basis={block.basis} />;
    case "components":
      return <Components items={block.items} onOpenComponent={onOpenComponent} />;
    case "diagram":
      // Placeholder until the diagram view is wired into work briefs.
      return <View style={styles.card}>
        <Text style={styles.title}>{block.diagram.title}</Text>
        <Text style={styles.meta}>{`${block.diagram.nodes.length} nodes · ${block.diagram.edges.length} relationships`}</Text>
      </View>;
    case "tasks":
      return <Tasks items={block.items} onOpenWork={onOpenWork} />;
    case "checks":
      return <Checks items={block.items} />;
    case "decisions":
      return <Decisions items={block.items} />;
    case "questions":
      return <Questions items={block.items} />;
    case "links":
      return <Links items={block.items} />;
    case "citations":
      return <Citations items={block.items} />;
    case "note":
      return <Note tone={block.tone} text={block.text} />;
  }
}
