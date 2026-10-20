import { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text, TextInput, View } from "react-native";
import { api, type Connection, type ProjectFile } from "../../api/client";
import { Button } from "../../components/Button";
import { theme } from "../../theme";

export function Files({ connection, id, online }: { connection: Connection; id: string; online: boolean }) {
  const [path, setPath] = useState("");
  const [file, setFile] = useState<ProjectFile | null>(null);
  const [requestedPath, setRequestedPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  async function open() {
    if (!online || busy || !path.trim()) return;
    const current = ++revision.current;
    setRequestedPath(path.trim());
    setBusy(true); setError("");
    try {
      const next = await api<ProjectFile>(connection, `/sessions/${id}/file?path=${encodeURIComponent(path.trim())}`);
      if (current === revision.current) setFile(next);
    } catch (error) { if (current === revision.current) setError((error as Error).message); }
    finally { if (current === revision.current) setBusy(false); }
  }
  return <View style={s.body}>
    <Text style={s.note}>Open a file inside this session’s project. Enter a project-relative path.</Text>
    <TextInput accessibilityLabel="Project file path" autoCapitalize="none" autoCorrect={false} placeholder="src/index.ts" placeholderTextColor={theme.colors.placeholder} value={path} onChangeText={setPath} style={s.input} onSubmitEditing={() => void open()} />
    <Button busy={busy} title="Open file" disabled={busy || !online || !path.trim()} onPress={() => void open()} />
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    {file ? <View style={busy || file.path !== requestedPath ? s.previewBusy : undefined}>
      <Text style={s.note} numberOfLines={1}>{file.path} · {file.size.toLocaleString()} bytes{!online ? " · cached" : ""}</Text>
      {file.text !== undefined ? <Text selectable style={s.code}>{file.text}</Text> : file.base64 && /^image\/(png|jpeg|gif|webp)$/.test(file.mimeType) ? <Image accessibilityLabel={file.name} source={{ uri: `data:${file.mimeType};base64,${file.base64}` }} style={s.image} resizeMode="contain" /> : <Text style={s.note}>Preview is not available for this file type.</Text>}
    </View> : null}
  </View>;
}
const s = StyleSheet.create({
  body: { gap: 14, paddingVertical: 14 }, note: { fontSize: 12, lineHeight: 19, color: theme.colors.mutedInk }, error: { color: theme.colors.error, fontSize: 13 },
  input: { padding: 12, minHeight: 48, borderWidth: 1, borderColor: theme.colors.fieldRule, borderRadius: theme.radius.control, color: theme.colors.ink },
  code: { fontFamily: theme.mono, fontSize: 11, lineHeight: 18, color: theme.colors.screenInk, backgroundColor: theme.colors.screenSurface, padding: 14 },
  image: { width: "100%", height: 320 },
  previewBusy: { opacity: 0.55 },
});
