import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, type Connection, type Me } from "../../api/client";
import { saveConnection } from "../../store/connection";
import { Button } from "../../components/Button";
import { theme } from "../../theme";

export function Pair({
  onPaired,
  initialError = "",
  onCancel,
}: {
  onPaired: (connection: Connection) => void;
  initialError?: string;
  onCancel?: () => void;
}) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [relayMachine, setRelayMachine] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function pair() {
    setBusy(true);
    setError("");
    try {
      const endpoint = new URL(url.trim());
      const local =
        __DEV__ &&
        ["127.0.0.1", "localhost", "10.0.2.2"].includes(endpoint.hostname) &&
        endpoint.protocol === "http:";
      if (
        (!local && endpoint.protocol !== "https:") ||
        endpoint.username ||
        endpoint.password ||
        endpoint.pathname !== "/" ||
        endpoint.search ||
        endpoint.hash
      )
        throw new Error("Use a bare HTTPS address on your private network.");
      const next: Connection = { url: endpoint.origin, token: token.trim(), ...(relayMachine.trim() ? { relay: { machineId: relayMachine.trim() } } : {}) };
      const me = await api<Me>(next, "/me");
      if (!mounted.current) return;
      const saved = await saveConnection({ ...next, id: me.machine?.id, machineId: me.machine?.id, label: label.trim() || me.machine?.label || endpoint.hostname });
      setToken("");
      if (mounted.current) onPaired(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={s.fill}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={s.pair}
      >
        <Text style={s.brand}>infinite</Text>
        <Text style={s.hero}>Pick up where{`\n`}you left off.</Text>
        <Text style={s.body}>
          Connect a laptop or cloud machine to create sessions, catch up, and steer from this phone.
        </Text>
        {onCancel ? <Button title="Back to machines" secondary onPress={onCancel} disabled={busy} /> : null}
        <Text style={s.label}>Machine name (optional)</Text>
        <TextInput accessibilityLabel="Machine name" value={label} onChangeText={setLabel} placeholder="My laptop or cloud" placeholderTextColor={theme.colors.placeholder} style={s.input} maxLength={80} />
        <Text style={s.label}>Host or relay address</Text>
        <TextInput
          accessibilityLabel="Host address"
          value={url}
          onChangeText={setUrl}
          placeholder="https://host.example.com"
          placeholderTextColor={theme.colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={s.input}
        />
        <Text style={s.label}>Relay machine ID (relay connections only)</Text>
        <TextInput accessibilityLabel="Relay machine ID" value={relayMachine} onChangeText={setRelayMachine} placeholder="Leave empty for a direct connection" placeholderTextColor={theme.colors.placeholder} autoCapitalize="none" autoCorrect={false} style={s.input} />
        <Text style={s.label}>Device key</Text>
        <TextInput
          accessibilityLabel="Device key"
          value={token}
          onChangeText={setToken}
          placeholder="Controller or viewer key"
          placeholderTextColor={theme.colors.placeholder}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={s.input}
        />
        <View style={s.space} />
        <Button
          title={busy ? "Connecting…" : "Connect this phone"}
          disabled={busy || !url || !token}
          onPress={pair}
        />
        {error ? (
          <Text accessibilityRole="alert" style={s.error}>
            {error}
          </Text>
        ) : null}
        <Text style={s.footnote}>
          Device keys stay in this phone’s secure storage. Owner keys can create and end sessions; controller keys can steer existing sessions. Relay connections are encrypted between this phone and the machine.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  pair: { padding: 28, paddingTop: 42 },
  brand: {
    fontSize: 30,
    letterSpacing: -1.1,
    fontWeight: "600",
    color: theme.colors.ink,
  },
  hero: {
    fontSize: 39,
    lineHeight: 44,
    fontWeight: "500",
    color: theme.colors.ink,
    letterSpacing: -1.1,
    marginTop: 60,
    marginBottom: 20,
  },
  body: {
    fontSize: 15,
    lineHeight: 24,
    color: theme.colors.mutedInk,
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.ink,
    marginBottom: 10,
    marginTop: 17,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.fieldRule,
    borderRadius: theme.radius.control,
    padding: 14,
    fontSize: 15,
    minHeight: 50,
    color: theme.colors.ink,
  },
  space: { height: 22 },
  error: {
    color: theme.colors.error,
    fontSize: 13,
    lineHeight: 20,
    marginVertical: 10,
  },
  footnote: {
    fontSize: 12,
    lineHeight: 19,
    color: theme.colors.mutedInk,
    marginTop: 26,
  },
});
