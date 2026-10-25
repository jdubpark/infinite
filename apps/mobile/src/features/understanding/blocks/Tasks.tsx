import { Text, View } from "react-native";
import type { TaskSummary } from "@infinite/remote";
import { Button } from "../../../components/Button";
import { Chip } from "../../../components/Glass";
import { RichText } from "./RichText";
import { styles } from "./styles";

/** One card per subtask: its recorded status, review and rubric numbers, and its component names. */
export function Tasks({ items, onOpenWork }: { items: TaskSummary[]; onOpenWork?: (workId: string) => void }) {
  return <View style={styles.stack}>
    {items.map(task => <TaskCard key={task.id} task={task} onOpenWork={onOpenWork} />)}
  </View>;
}

function TaskCard({ task, onOpenWork }: { task: TaskSummary; onOpenWork?: (workId: string) => void }) {
  const workId = task.workId;
  const rubric = task.rubric;
  const diff = task.diffStat;
  return <View style={styles.card}>
    <Text style={styles.title}>{task.title}</Text>
    <Text style={styles.meta}>{[task.status, task.role ?? "role not recorded", `revision ${task.revision}`].join(" · ")}</Text>
    {task.summary.length ? <RichText nodes={task.summary} basis="agent" compact /> : null}
    {diff ? <Text style={styles.meta}>{`+${diff.added} −${diff.removed} · ${diff.files} ${diff.files === 1 ? "file" : "files"}`}</Text> : null}
    {task.reviewRounds > 0 ? <Text style={styles.meta}>{`review rounds ${task.reviewRounds}`}</Text> : null}
    {rubric ? <Text style={styles.meta}>{`correctness ${rubric.correctness} · cleanliness ${rubric.cleanliness} · extensibility ${rubric.extensibility} · docs ${rubric.docs}`}</Text> : null}
    {task.componentNames.length ? <View style={styles.row}>
      {task.componentNames.map(name => <Chip key={name} label={name} />)}
    </View> : null}
    {workId && onOpenWork ? <View style={styles.row}>
      <Button compact secondary title="Open subteam" onPress={() => onOpenWork(workId)} />
    </View> : null}
  </View>;
}
