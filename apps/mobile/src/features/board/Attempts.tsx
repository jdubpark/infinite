import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { BoardItem } from "../../api/client";
import { Card } from "../../components/Glass";
import { StatusIcon } from "../../components/Icon";
import { age } from "../../status";
import { theme } from "../../theme";
import { Section, t } from "../teams/parts";
import { boardKind, boardStatusLabel } from "./model";

export function Attempts({ attempts, current, machine, now }: { attempts: BoardItem[]; current: string; machine: string; now: number }) {
  const router = useRouter();
  const open = (attempt: BoardItem) => {
    if (attempt.kind === "mission") router.replace({ pathname: "/mission/[id]", params: { id: attempt.id, machine } });
    else if (attempt.kind === "team") router.replace({ pathname: "/team/[id]", params: { id: attempt.id, machine } });
    else router.replace({ pathname: "/goal/[id]", params: { id: attempt.id, machine } });
  };
  return <Section title="Attempts" count={attempts.length}>
    <Card style={s.card}>
      {attempts.map(attempt => {
        const viewing = attempt.id === current;
        const number = attempt.attempt?.number ?? 0;
        const started = age(attempt.createdAt ?? attempt.updatedAt, now);
        return <Pressable key={`${attempt.kind}/${attempt.id}`} accessibilityRole="button" accessibilityState={{ selected: viewing, disabled: viewing }}
          accessibilityLabel={`Attempt ${number}, ${boardStatusLabel(attempt)}${started ? `, started ${started} ago` : ""}${viewing ? ", viewing" : ""}`}
          disabled={viewing} onPress={() => open(attempt)} style={({ pressed }) => [s.row, pressed && !viewing && s.pressed]}>
          <View style={s.icon}><StatusIcon kind={boardKind(attempt)} size={15} /></View>
          <View style={s.main}>
            <View style={s.line}>
              <Text style={s.number}>Attempt {number}</Text>
              <Text style={t.note}>{boardStatusLabel(attempt)}</Text>
              {started ? <Text style={t.note}>{started}</Text> : null}
              {viewing ? <Text style={s.viewing}>Viewing</Text> : null}
            </View>
            <Text style={t.note} numberOfLines={1}>{attempt.detail}</Text>
          </View>
        </Pressable>;
      })}
    </Card>
  </Section>;
}

const s = StyleSheet.create({
  card: { padding: 0, gap: 0, overflow: "hidden" },
  row: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  icon: { width: 20, alignItems: "center" },
  main: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  number: { fontSize: 14, fontWeight: "600", color: theme.colors.ink },
  viewing: { fontSize: 12, fontWeight: "600", color: theme.colors.forest },
});
