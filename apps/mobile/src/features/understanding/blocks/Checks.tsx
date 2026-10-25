import { ScrollView, Text, View } from "react-native";
import type { CheckSummary } from "@infinite/remote";
import { theme } from "../../../theme";
import { formatTime } from "./format";
import { styles } from "./styles";

const STATUS: Record<CheckSummary["status"], { ink: string; surface: string }> = {
  passed: { ink: theme.colors.forest, surface: theme.colors.secondarySurface },
  failed: { ink: theme.colors.error, surface: theme.colors.secondarySurface },
  running: { ink: theme.colors.warningInk, surface: theme.colors.warningSurface },
  interrupted: { ink: theme.colors.warningInk, surface: theme.colors.warningSurface },
};

/** Recorded verification commands. The output tail is the host's record, shown as terminal output. */
export function Checks({ items }: { items: CheckSummary[] }) {
  return <View style={styles.stack}>
    {items.map((check, index) => <CheckCard key={`${check.command}/${index}`} check={check} />)}
  </View>;
}

function CheckCard({ check }: { check: CheckSummary }) {
  const status = STATUS[check.status];
  return <View style={styles.card}>
    <Text selectable style={styles.mono}>{check.command}</Text>
    <View style={styles.row}>
      <View style={[styles.pill, { backgroundColor: status.surface }]}>
        <Text style={[styles.pillText, { color: status.ink }]}>{`${check.phase} · ${check.status}`}</Text>
      </View>
      <Text style={styles.meta}>{check.exitCode === null ? "no exit code" : `exit ${check.exitCode}`}</Text>
    </View>
    {check.headCommit ? <Text style={styles.meta}>{`head ${check.headCommit.slice(0, 12)}`}</Text> : null}
    <Text style={styles.meta}>{`started ${formatTime(check.startedAt)}`}</Text>
    <Text style={styles.meta}>{check.finishedAt ? `finished ${formatTime(check.finishedAt)}` : "not finished"}</Text>
    {check.outputTail ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.terminal} contentContainerStyle={styles.panelContent}>
      <Text selectable style={styles.terminalText}>{check.outputTail}</Text>
    </ScrollView> : null}
  </View>;
}
