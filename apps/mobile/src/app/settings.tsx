import { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
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

// Same author palette as the web composer — custom hex allowed on top.
const NAME_COLORS = [
  "#0d9488", "#3b82f6", "#8b5cf6", "#db2777",
  "#ca8a04", "#16a34a", "#f43f5e", "#0ea5e9",
];

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
    name_color: string | null;
  } | null>(null);
  const [hex, setHex] = useState("");
  const [colorErr, setColorErr] = useState("");

  const saveColor = async (v: string) => {
    setColorErr("");
    try {
      await api.updateMe({ name_color: v });
      setMe((m) => (m ? { ...m, name_color: v || null } : m));
    } catch (e) {
      setColorErr(e instanceof Error ? e.message : "Could not save");
    }
  };

  const commitHex = () => {
    const v = hex.trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
      setColorErr("Use #rrggbb");
      return;
    }
    void saveColor(v);
  };

  const [avatarUrl, setAvatarUrl] = useState("");
  const [avatarErr, setAvatarErr] = useState("");
  const saveAvatarUrl = async () => {
    const u = avatarUrl.trim();
    if (!u) return;
    setAvatarErr("");
    try {
      const r = await api.setImageURL("/api/me/avatar", u);
      setMe((m) =>
        m ? { ...m, avatar_url: r.avatar_url ?? m.avatar_url } : m,
      );
      setAvatarUrl("");
    } catch (e) {
      setAvatarErr(e instanceof Error ? e.message : "Could not set avatar");
    }
  };

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
        <Text style={[s.section, { marginTop: 14, marginLeft: 0 }]}>
          Name color
        </Text>
        <View style={s.swatchRow}>
          {NAME_COLORS.map((c) => (
            <Pressable
              key={c}
              onPress={() => void saveColor(c)}
              style={[
                s.swatch,
                { backgroundColor: c },
                me?.name_color === c && s.swatchActive,
              ]}
            />
          ))}
          <TextInput
            value={hex}
            onChangeText={setHex}
            onSubmitEditing={commitHex}
            onBlur={commitHex}
            placeholder="#rrggbb"
            placeholderTextColor={C.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={s.hexInput}
          />
        </View>
        <View style={s.colorFoot}>
          {me?.name_color ? (
            <Pressable onPress={() => void saveColor("")}>
              <Text style={s.clearLink}>Reset to palette</Text>
            </Pressable>
          ) : (
            <Text style={s.muted}>palette default</Text>
          )}
          {colorErr ? <Text style={s.err}>{colorErr}</Text> : null}
        </View>
        <Text style={[s.section, { marginTop: 14, marginLeft: 0 }]}>
          Avatar from URL
        </Text>
        <View style={s.swatchRow}>
          <TextInput
            value={avatarUrl}
            onChangeText={setAvatarUrl}
            onSubmitEditing={() => void saveAvatarUrl()}
            placeholder="https://example.com/avatar.png"
            placeholderTextColor={C.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={s.hexInput}
          />
          <Pressable style={s.setBtn} onPress={() => void saveAvatarUrl()}>
            <Text style={s.setBtnText}>Set</Text>
          </Pressable>
        </View>
        {avatarErr ? <Text style={[s.err, { marginTop: 6 }]}>{avatarErr}</Text> : null}
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
        <Pressable
          style={{ marginTop: 10 }}
          onPress={async () => {
            try {
              await api.logout();
            } catch {
              await logout();
            }
            // Login keeps the last server prefilled — edit it there.
            router.replace("/login");
          }}
        >
          <Text style={s.clearLink}>Sign in to a different server</Text>
        </Pressable>
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
    swatchRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      alignItems: "center",
    },
    swatch: { width: 26, height: 26, borderRadius: 13 },
    swatchActive: { borderWidth: 2, borderColor: C.text },
    hexInput: {
      flex: 1,
      minWidth: 90,
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      color: C.text,
      fontSize: 13,
    },
    colorFoot: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginTop: 8,
    },
    clearLink: { color: C.accent, fontSize: 12.5, fontWeight: "600" },
    setBtn: {
      backgroundColor: C.accent,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    setBtnText: { color: C.onAccent, fontWeight: "600", fontSize: 13 },
    err: { color: C.danger, fontSize: 12 },
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
