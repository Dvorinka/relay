import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import {
  api,
  fileUrl,
  getCookie,
  type Review,
} from "../../../lib/api";
import { useTheme, type Palette } from "../../../lib/theme";

export default function ReviewsScreen() {
  const C = useTheme();
  const s = useMemo(() => themedStyles(C), [C]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const [items, setItems] = useState<Review[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api.reviews(id);
      setItems(r.reviews);
    } catch {
      // transient
    } finally {
      setRefreshing(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const respond = async (reviewId: string, status: string, response?: string) => {
    try {
      await api.respondReview(reviewId, status, response);
      setNoteFor(null);
      setNote("");
      await load();
    } catch (e) {
      Alert.alert("Failed", e instanceof Error ? e.message : "try again");
    }
  };

  const pending = items.filter((r) => r.status === "pending");
  const done = items.filter((r) => r.status !== "pending");
  const ordered = [...pending, ...done];

  return (
    <FlatList
      data={ordered}
      keyExtractor={(r) => r.id}
      contentContainerStyle={{ padding: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={load}
          tintColor={C.accent}
        />
      }
      ListEmptyComponent={
        <Text style={s.empty}>No reviews yet. Agents submit them via MCP.</Text>
      }
      renderItem={({ item }) => {
        const avatar = fileUrl(item.agent?.avatar_url);
        const open = item.status === "pending";
        return (
          <View style={[s.card, open && s.cardPending]}>
            <View style={s.head}>
              {avatar ? (
                <Image
                  source={{ uri: avatar, headers: { cookie: getCookie() } }}
                  style={s.avatar}
                />
              ) : (
                <View style={[s.avatar, s.avatarFallback]}>
                  <Text style={s.avatarLetter}>
                    {(item.agent?.name ?? "A").slice(0, 1).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={s.title}>{item.title}</Text>
                <Text style={s.muted}>
                  {item.agent?.name}
                  {item.issue ? ` · ${item.issue.key}` : ""} ·{" "}
                  {new Date(item.created_at).toLocaleDateString()}
                </Text>
              </View>
              <Text
                style={[
                  s.status,
                  item.status === "approved" && s.statusOk,
                  item.status === "changes_requested" && s.statusChanges,
                ]}
              >
                {item.status.replace("_", " ")}
              </Text>
            </View>
            {item.summary ? (
              <Text style={s.summary} numberOfLines={4}>
                {item.summary}
              </Text>
            ) : null}
            {item.verify ? (
              <Text style={s.verify} numberOfLines={2}>
                Verify: {item.verify}
              </Text>
            ) : null}
            {open && (
              <View style={s.actions}>
                <Pressable
                  style={s.approve}
                  onPress={() => respond(item.id, "approved")}
                >
                  <Text style={s.approveText}>Approve</Text>
                </Pressable>
                <Pressable
                  style={s.changes}
                  onPress={() => setNoteFor(noteFor === item.id ? null : item.id)}
                >
                  <Text style={s.changesText}>Request changes</Text>
                </Pressable>
              </View>
            )}
            {open && noteFor === item.id && (
              <View style={s.noteBox}>
                <TextInput
                  style={s.noteInput}
                  placeholder="What should change?"
                  placeholderTextColor={C.muted}
                  value={note}
                  onChangeText={setNote}
                  multiline
                  autoFocus
                />
                <Pressable
                  style={[s.changes, !note.trim() && { opacity: 0.4 }]}
                  disabled={!note.trim()}
                  onPress={() => respond(item.id, "changes_requested", note)}
                >
                  <Text style={s.changesText}>Send</Text>
                </Pressable>
              </View>
            )}
            {!open && item.response ? (
              <Text style={s.muted}>“{item.response}”</Text>
            ) : null}
          </View>
        );
      }}
    />
  );
}

const themedStyles = (C: Palette) =>
  StyleSheet.create({
    empty: { color: C.muted, textAlign: "center", marginTop: 60 },
    card: {
      backgroundColor: C.surface,
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 14,
      marginBottom: 10,
    },
    cardPending: { borderLeftColor: "#8b5cf6", borderLeftWidth: 3 },
    head: { flexDirection: "row", alignItems: "center", gap: 10 },
    avatar: { width: 34, height: 34, borderRadius: 17 },
    avatarFallback: {
      backgroundColor: C.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarLetter: { color: C.onAccent, fontWeight: "700" },
    title: { color: C.text, fontWeight: "600", fontSize: 15 },
    muted: { color: C.muted, fontSize: 12, marginTop: 2 },
    status: {
      color: C.muted,
      fontSize: 11,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    statusOk: { color: "#34c98e" },
    statusChanges: { color: C.danger },
    summary: { color: C.text, fontSize: 14, lineHeight: 20, marginTop: 10 },
    verify: { color: C.muted, fontSize: 12, marginTop: 8, fontStyle: "italic" },
    actions: { flexDirection: "row", gap: 8, marginTop: 12 },
    approve: {
      backgroundColor: C.accent,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    approveText: { color: C.onAccent, fontWeight: "600", fontSize: 13 },
    changes: {
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    changesText: { color: C.text, fontWeight: "600", fontSize: 13 },
    noteBox: { marginTop: 10, gap: 8 },
    noteInput: {
      backgroundColor: C.surface2,
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 8,
      color: C.text,
      padding: 10,
      minHeight: 60,
      textAlignVertical: "top",
    },
  });
