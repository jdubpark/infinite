import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, type Connection } from "../../api/client";
import { saveConnection } from "../../store/connection";
import { Button } from "../../components/Button";
import { theme } from "../../theme";

export function Pair({
  onPaired,
  initialError = "",
}: {
  onPaired: (connection: Connection) => void;
  initialError?: string;
}) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
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
      const next = { url: endpoint.origin, token: token.trim() };
      await api(next, "/me");
      await saveConnection(next);
      setToken("");
      onPaired(next);
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
          Your agents stay on your host. Connect through your private network to
          catch up and steer.
        </Text>
        <Text style={s.label}>Host address</Text>
        <TextInput
          accessibilityLabel="Host address"
          value={url}
          onChangeText={setUrl}
          placeholder="https://host.your-tailnet.ts.net"
          placeholderTextColor={theme.colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={s.input}
        />
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
          The device key is stored in this phone’s secure storage. New sessions
          start from your laptop.
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
