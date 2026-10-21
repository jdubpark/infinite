import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import * as Crypto from "expo-crypto";
import { api, ApiError, type Connection, type Me, type ProjectGroup, type ProjectGroupCheckout, type ProjectGroupList, type ProjectGroupUpdateRequest } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import { Button } from "../../components/Button";
import { Chip, TopBar } from "../../components/Glass";
import { Section, t } from "../teams/parts";
import { theme } from "../../theme";

const STALE_MESSAGE = "This project changed. Try again.";

/** One project: its name, repositories and checkouts, and owner-only changes. */
export function ProjectDetail({ connection, id }: { connection: Connection; id: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const poll = usePoll(async () => {
    const [list, me] = await Promise.all([api<ProjectGroupList>(connection, "/project-groups"), api<Me>(connection, "/me")]);
    return { group: list.groups.find(candidate => candidate.id === id) ?? null, me };
  }, 5000, [connection, id]);
  const group = poll.data?.group ?? null;
  const owner = poll.data?.me.role === "owner";

  /** Sends one owner change against the revision on screen. Returns whether the host accepted it. */
  async function change(body: Omit<ProjectGroupUpdateRequest, "requestId" | "revision">): Promise<boolean> {
    if (!group || busy) return false;
    setBusy(true);
    try {
      await api(connection, `/project-groups/${encodeURIComponent(group.id)}`, {
        method: "PUT", body: { requestId: Crypto.randomUUID(), revision: group.revision, ...body },
      });
      setMessage(null);
      poll.refresh();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "stale-project-group-revision") {
        setMessage(STALE_MESSAGE);
        poll.refresh();
      } else {
        setMessage((error as Error).message);
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  function remove(current: ProjectGroup) {
    if (busy) return;
    Alert.alert(`Remove ${current.name}?`, "Its checkouts fold back into repository projects.", [
      { text: "Keep", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void removeNow(current) },
    ]);
  }

  async function removeNow(current: ProjectGroup) {
    setBusy(true);
    try {
      await api(connection, `/project-groups/${encodeURIComponent(current.id)}`, {
        method: "DELETE", body: { requestId: Crypto.randomUUID(), revision: current.revision },
      });
      router.back();
    } catch (error) {
      if (error instanceof ApiError && error.code === "stale-project-group-revision") {
        setMessage(STALE_MESSAGE);
        poll.refresh();
      } else {
        setMessage((error as Error).message);
      }
    } finally {
      setBusy(false);
    }
  }

  function moveOrPrimary(current: ProjectGroup, checkout: ProjectGroupCheckout) {
    if (!owner || busy) return;
    Alert.alert(checkout.name, undefined, [
      { text: "Make primary", onPress: () => void change({ primary: [checkout.projectId] }) },
      {
        text: "Move to its own project",
        onPress: () => void change({
          repos: current.repos.flatMap(repo => repo.checkouts.map(item => item.projectId)).filter(projectId => projectId !== checkout.projectId),
        }),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  if (!poll.data && poll.loading) return <View style={s.fill}><TopBar backLabel="Projects" onBack={() => router.back()} /><ActivityIndicator style={s.loading} color={theme.colors.forest} /></View>;
  if (!group) return <View style={s.fill}>
    <TopBar backLabel="Projects" onBack={() => router.back()} />
    <Text style={s.note}>This project is no longer available.</Text>
  </View>;

  const name = draft ?? group.name;
  const trimmed = name.trim();
  const canSave = owner && draft !== null && trimmed.length > 0 && trimmed !== group.name && !busy;

  return <View style={s.fill}>
    <TopBar backLabel="Projects" onBack={() => router.back()} title={group.name} />
    <ScrollView style={s.fill} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={poll.refreshing} onRefresh={poll.refresh} tintColor={theme.colors.forest} colors={[theme.colors.forest]} />}>
      <Section title="Name">
        <TextInput accessibilityLabel="Project name" value={name} onChangeText={setDraft} editable={owner && !busy} maxLength={100}
          placeholderTextColor={theme.colors.placeholder} style={t.input} />
        {owner ? <View style={s.actions}>
          <Button compact secondary title="Save" disabled={!canSave} onPress={() => { void change({ name: trimmed }).then(saved => { if (saved) setDraft(null); }); }} />
        </View> : null}
      </Section>

      {group.repos.map(repo => <Section key={repo.projectId} title={repo.name}>
        {[...repo.checkouts].sort((a, b) => Number(b.primary) - Number(a.primary)).map(checkout => {
          const movable = owner && !checkout.primary;
          const body = <>
            <View style={s.checkoutHead}>
              <Text style={s.checkoutName} numberOfLines={1}>{checkout.name}</Text>
              {checkout.primary ? <Chip label="Primary" selected /> : null}
            </View>
            <Text style={t.mono} selectable numberOfLines={1}>{checkout.path}</Text>
          </>;
          return movable
            ? <Pressable key={checkout.projectId} accessibilityRole="button" accessibilityLabel={`${checkout.name} options`}
                onPress={() => moveOrPrimary(group, checkout)} style={({ pressed }) => [s.checkout, pressed && s.pressed]}>{body}</Pressable>
            : <View key={checkout.projectId} style={s.checkout}>{body}</View>;
        })}
      </Section>)}

      {owner ? <View style={s.actions}>
        <Button secondary title={group.hidden ? "Show project" : "Hide project"} disabled={busy} onPress={() => void change({ hidden: !group.hidden })} />
        {group.kind === "owner" ? <Button secondary destructive title="Remove project" disabled={busy} onPress={() => remove(group)} /> : null}
      </View> : <Text style={s.note}>Only the owner can change projects.</Text>}

      {message ? <Text accessibilityLiveRegion="polite" style={s.message}>{message}</Text> : null}
    </ScrollView>
  </View>;
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: theme.colors.paper },
  content: { paddingHorizontal: 16, paddingBottom: 32 },
  loading: { marginTop: 100 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 12 },
  checkout: { gap: 4, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.rule },
  pressed: { backgroundColor: theme.colors.secondarySurface },
  checkoutHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  checkoutName: { flexShrink: 1, fontSize: 15, fontWeight: "600", color: theme.colors.ink },
  note: { marginVertical: 16, fontSize: 12, lineHeight: 17, color: theme.colors.mutedInk },
  message: { marginVertical: 8, fontSize: 12, lineHeight: 17, color: theme.colors.error },
});
