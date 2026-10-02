import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { router } from "expo-router";
import {
  api,
  fileUrl,
  getCookie,
  getServer,
  logout,
} from "../lib/api";
import {
  useTheme,
  useThemePreference,
  type Palette,
  type ThemePreference,
} from "../lib/theme";

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function Settings() {
  const C = useTheme();
  const s = useMemo(() => themedStyles(C), [C]);
  const { preference, setPreference } = useThemePreference();
  const [me, setMe] = useState<{
    name: string;
    email: string;
    avatar_url: string | null;
  } | null>(null);

  useEffect(() => {
    api
      .me()
      .then((r) => setMe(r.user))
      .catch(() => {});
  }, []);

  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      await logout();
    }
    router.replace("/login");
  };

  const avatar = fileUrl(me?.avatar_url);

  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.section}>Account</Text>
      <View style={s.card}>
        <View style={s.acctRow}>
          {avatar ? (
            <Image
              source={{ uri: avatar, headers: { cookie: getCookie() } }}
              style={s.avatar}
            />
          ) : (
            <View style={[s.avatar, s.avatarFallback]}>
              <Text style={s.avatarLetter}>
                {(me?.name ?? "?").slice(0, 1).toUpperCase()}
              </Text>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={s.name}>{me?.name ?? "…"}</Text>
            <Text style={s.muted}>{me?.email ?? ""}</Text>
          </View>
        </View>
      </View>

      <Text style={s.section}>Appearance</Text>
      <View style={s.card}>
        <View style={s.segRow}>
          {OPTIONS.map((o) => {
            const active = preference === o.value;
            return (
              <Pressable
                key={o.value}
                style={[s.seg, active && s.segActive]}
                onPress={() => setPreference(o.value)}
              >
                <Text style={[s.segText, active && s.segTextActive]}>
                  {o.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Text style={s.section}>Server</Text>
      <View style={s.card}>
        <Text style={s.muted}>{getServer()}</Text>
      </View>

      <Pressable style={s.signOut} onPress={signOut}>
        <Text style={s.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const themedStyles = (C: Palette) =>
  StyleSheet.create({
    page: { padding: 14, paddingBottom: 40 },
    section: {
      color: C.faint,
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.8,
      textTransform: "uppercase",
      marginTop: 18,
      marginBottom: 8,
      marginLeft: 4,
    },
    card: {
      backgroundColor: C.surface,
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 14,
    },
    acctRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    avatar: { width: 44, height: 44, borderRadius: 22 },
    avatarFallback: {
      backgroundColor: C.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarLetter: { color: C.onAccent, fontWeight: "700", fontSize: 18 },
    name: { color: C.text, fontWeight: "600", fontSize: 16 },
    muted: { color: C.muted, fontSize: 13, marginTop: 2 },
    segRow: { flexDirection: "row", gap: 6 },
    seg: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 9,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: C.border,
      backgroundColor: C.surface2,
    },
    segActive: { backgroundColor: C.accent, borderColor: C.accent },
    segText: { color: C.muted, fontWeight: "600", fontSize: 13 },
    segTextActive: { color: C.onAccent },
    signOut: {
      marginTop: 28,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: C.danger,
      paddingVertical: 12,
      alignItems: "center",
    },
    signOutText: { color: C.danger, fontWeight: "600", fontSize: 15 },
  });
