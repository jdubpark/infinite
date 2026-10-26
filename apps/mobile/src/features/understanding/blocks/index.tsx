import { View } from "react-native";
import type { Basis, WorkBlock } from "@infinite/remote";
import { DiagramView } from "../diagram/DiagramView";
import { BasisLabel } from "./BasisLabel";
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

/** Basis for block kinds that carry no basis of their own. Kinds with per-item bases label each item instead. */
const IMPLIED_BASIS: Partial<Record<WorkBlock["kind"], Basis>> = {
  components: "source",
  tasks: "agent",
  checks: "host",
  decisions: "host",
  questions: "model",
  citations: "model",
};

/** Renders one block of a work brief. Each block shows its own basis labels. */
export function BlockView({ block, onOpenComponent, onOpenWork }: { block: WorkBlock; onOpenComponent?: (componentId: string) => void; onOpenWork?: (workId: string) => void }) {
  const implied = IMPLIED_BASIS[block.kind];
  const view = renderBlock(block, onOpenComponent, onOpenWork);
  if (!implied) return view;
  return <View style={styles.stack}>
    <BasisLabel basis={implied} />
    {view}
  </View>;
}

function renderBlock(block: WorkBlock, onOpenComponent?: (componentId: string) => void, onOpenWork?: (workId: string) => void) {
  switch (block.kind) {
    case "facts":
      return <Facts items={block.items} />;
    case "rich":
      return <RichText nodes={block.nodes} basis={block.basis} />;
    case "components":
      return <Components items={block.items} onOpenComponent={onOpenComponent} />;
    case "diagram":
      return <View style={styles.stack}>
        <BasisLabel basis={block.diagram.basis} />
        <DiagramView diagram={block.diagram} onOpenComponent={onOpenComponent} />
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
