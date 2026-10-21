import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import { api, type Connection, type ProjectGroup, type ProjectGroupSuggestion } from "../../api/client";
import { Button } from "../../components/Button";
import { theme } from "../../theme";
import { combineLabel } from "./model";

/** One suggested combination with its Combine control. The host creates the owner project on confirm. */
export function CombineRow({ connection, suggestion, groups, onCombined, onError }: {
  connection: Connection; suggestion: ProjectGroupSuggestion; groups: ProjectGroup[];
  onCombined: () => void; onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function combine() {
    if (busy) return;
    setBusy(true);
    try {
      await api(connection, "/project-groups", { method: "POST", body: { requestId: Crypto.randomUUID(), name: suggestion.name, repos: suggestion.repos } });
      onCombined();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return <View style={s.row}>
    <Text style={s.label} numberOfLines={2}>{combineLabel(suggestion, groups)}</Text>
    <Button compact secondary title="Combine" busy={busy} disabled={busy} onPress={() => void combine()} />
  </View>;
}

const s = StyleSheet.create({
  row: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  label: { flex: 1, fontSize: 14, lineHeight: 19, color: theme.colors.ink },
});
