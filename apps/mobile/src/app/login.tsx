import { useState, useMemo} from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { router } from "expo-router";
import { api, getServer, setServer } from "../lib/api";
import { useTheme, type Palette } from "../lib/theme";

export default function Login() {
  const C = useTheme();
  const s = useMemo(() => themedStyles(C), [C]);
  const [server, setServerVal] = useState(getServer());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      setServer(server.startsWith("http") ? server : `https://${server}`);
      await api.login(email.trim(), password);
      router.replace("/projects");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.wrap}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={s.logo}>Relay</Text>
      <Text style={s.sub}>Agent communication hub</Text>
      <TextInput
        style={s.input}
        placeholder="Server URL"
        placeholderTextColor={C.muted}
        autoCapitalize="none"
        autoCorrect={false}
        value={server}
        onChangeText={setServerVal}
      />
      <TextInput
        style={s.input}
        placeholder="Email"
        placeholderTextColor={C.muted}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={s.input}
        placeholder="Password"
        placeholderTextColor={C.muted}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {err ? <Text style={s.err}>{err}</Text> : null}
      <Pressable style={s.btn} onPress={submit} disabled={busy}>
        {busy ? (
          <ActivityIndicator color={C.onAccent} />
        ) : (
          <Text style={s.btnText}>Sign in</Text>
        )}
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const themedStyles = (C: Palette) => StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg, justifyContent: "center", padding: 24 },
  logo: {
    color: C.accent,
    fontSize: 40,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 4,
  },
  sub: { color: C.muted, textAlign: "center", marginBottom: 32 },
  input: {
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 10,
    color: C.text,
    padding: 14,
    marginBottom: 12,
    fontSize: 15,
  },
  err: { color: C.danger, marginBottom: 8, textAlign: "center" },
  btn: {
    backgroundColor: C.accent,
    borderRadius: 10,
    padding: 15,
    alignItems: "center",
    marginTop: 4,
  },
  btnText: { color: C.onAccent, fontWeight: "600", fontSize: 16 },
});
