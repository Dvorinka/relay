import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, type Brief, type Message } from "../../../lib/api";
import { SceneSvg } from "../../../components/SceneSvg";
import { useTheme, type Palette } from "../../../lib/theme";

export default function BriefsScreen() {
  const C = useTheme();
  const s = useMemo(() => themedStyles(C), [C]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const [items, setItems] = useState<Brief[]>([]);
  const [policy, setPolicy] = useState("on_request");
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<Brief | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api.briefs(id);
      setItems(r.briefs);
      setPolicy(r.policy);
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

  const create = async () => {
    const title = newTitle.trim();
    if (!title) return;
    try {
      const b = await api.createBrief(id, { title });
      setNewTitle("");
      setCreating(false);
      await load();
      setOpen(b);
    } catch (e) {
      Alert.alert("Failed", e instanceof Error ? e.message : "try again");
    }
  };

  return (
    <View style={{ flex: 1 }}>
      {policy !== "never" && (
        <View style={s.newRow}>
          {creating ? (
            <>
              <TextInput
                style={s.newInput}
                placeholder="Brief title"
                placeholderTextColor={C.muted}
                value={newTitle}
                onChangeText={setNewTitle}
                autoFocus
                onSubmitEditing={create}
              />
              <Pressable style={s.newBtn} onPress={create}>
                <Text style={s.newBtnText}>Add</Text>
              </Pressable>
              <Pressable
                style={s.cancelBtn}
                onPress={() => {
                  setCreating(false);
                  setNewTitle("");
                }}
              >
                <Text style={s.cancelText}>✕</Text>
              </Pressable>
            </>
          ) : (
            <Pressable style={s.newToggle} onPress={() => setCreating(true)}>
              <Text style={s.newToggleText}>+ New brief — sketch a canvas</Text>
            </Pressable>
          )}
        </View>
      )}
      <FlatList
        data={items}
        keyExtractor={(b) => b.id}
        contentContainerStyle={{ padding: 12 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={load}
            tintColor={C.accent}
          />
        }
        ListEmptyComponent={
          <Text style={s.empty}>
            No briefs yet. Agents post Excalidraw diagrams here; you can draw
            one too on web/desktop.
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable style={s.card} onPress={() => setOpen(item)}>
            <View style={s.head}>
              <Text style={s.title} numberOfLines={1}>
                {item.title}
              </Text>
              <Text
                style={[
                  s.status,
                  item.status === "resolved" && { color: "#34c98e" },
                ]}
              >
                {item.status}
              </Text>
            </View>
            <Text style={s.muted}>
              {item.author_name ?? "agent"}
              {item.issue_id ? " · issue" : ""}
            </Text>
          </Pressable>
        )}
      />

      <Modal
        visible={!!open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(null)}
      >
        {open && (
          <BriefDetail
            brief={open}
            C={C}
            onClose={() => setOpen(null)}
            onChanged={load}
          />
        )}
      </Modal>
    </View>
  );
}

function BriefDetail(props: {
  brief: Brief;
  C: Palette;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { C } = props;
  const s = useMemo(() => themedStyles(C), [C]);
  const [brief, setBrief] = useState(props.brief);
  const [comments, setComments] = useState<Message[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const insets = useSafeAreaInsets();

  const loadComments = useCallback(async () => {
    try {
      const conv = await api.briefConversation(brief.id);
      setConvId(conv.id);
      const r = await api.messages(conv.id);
      setComments(r.messages.slice().reverse());
    } catch {
      // transient
    }
  }, [brief.id]);

  useFocusEffect(
    useCallback(() => {
      loadComments();
    }, [loadComments]),
  );

  const send = async () => {
    const body = draft.trim();
    if (!body || !convId || sending) return;
    setSending(true);
    try {
      await api.postMessage(convId, body);
      setDraft("");
      await loadComments();
    } catch (e) {
      Alert.alert("Failed", e instanceof Error ? e.message : "try again");
    } finally {
      setSending(false);
    }
  };

  const setStatus = async (status: string) => {
    try {
      const b = await api.updateBrief(brief.id, { status });
      setBrief(b);
      props.onChanged();
    } catch {
      // transient
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[s.detailHead, { paddingTop: 14 + insets.top }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.detailTitle} numberOfLines={1}>
            {brief.title}
          </Text>
          <Text style={s.muted}>
            {brief.author_name ?? "agent"} · {brief.status}
          </Text>
        </View>
        {brief.status !== "resolved" ? (
          <Pressable style={s.smallBtn} onPress={() => setStatus("resolved")}>
            <Text style={s.smallBtnText}>Resolve</Text>
          </Pressable>
        ) : (
          <Pressable style={s.smallBtn} onPress={() => setStatus("open")}>
            <Text style={s.smallBtnText}>Reopen</Text>
          </Pressable>
        )}
        <Pressable onPress={props.onClose} style={s.closeBtn}>
          <Text style={s.closeText}>✕</Text>
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
        <View style={s.canvasBox}>
          <SceneSvg scene={brief.scene} />
        </View>
        {brief.summary ? (
          <Text style={s.summary}>{brief.summary}</Text>
        ) : null}
        <Text style={s.commentsLabel}>
          Comments — the agent watching this project can iterate on them
        </Text>
        {comments.length === 0 && (
          <Text style={s.muted}>
            No comments yet — suggest changes and the agent can revise the
            diagram.
          </Text>
        )}
        {comments.map((m) => (
          <View key={m.id} style={s.comment}>
            <Text style={s.muted}>{m.author.name}</Text>
            <Text style={s.commentBody}>{m.body}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={s.sendRow}>
        <TextInput
          style={s.sendInput}
          placeholder="Comment on this brief…"
          placeholderTextColor={C.muted}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={send}
        />
        <Pressable
          style={[s.sendBtn, (!draft.trim() || sending) && { opacity: 0.4 }]}
          disabled={!draft.trim() || sending}
          onPress={send}
        >
          <Text style={s.newBtnText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const themedStyles = (C: Palette) =>
  StyleSheet.create({
    empty: { color: C.muted, textAlign: "center", marginTop: 60, marginHorizontal: 24 },
    newRow: { padding: 12, paddingBottom: 0, flexDirection: "row" },
    newToggle: {
      borderColor: C.border,
      borderWidth: 1,
      borderStyle: "dashed",
      borderRadius: 10,
      padding: 10,
      alignItems: "center",
    },
    newToggleText: { color: C.muted, fontSize: 13 },
    newInput: {
      flex: 1,
      backgroundColor: C.surface2,
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 8,
      color: C.text,
      padding: 10,
      marginRight: 8,
    },
    newBtn: {
      backgroundColor: C.accent,
      borderRadius: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    newBtnText: { color: C.onAccent, fontWeight: "600" },
    cancelBtn: { justifyContent: "center", paddingHorizontal: 10 },
    cancelText: { color: C.muted, fontSize: 16 },
    card: {
      backgroundColor: C.surface,
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 14,
      marginBottom: 10,
    },
    head: { flexDirection: "row", alignItems: "center", gap: 10 },
    title: { flex: 1, color: C.text, fontWeight: "600", fontSize: 15 },
    status: {
      color: C.accent,
      fontSize: 11,
      fontWeight: "700",
      textTransform: "uppercase",
    },
    muted: { color: C.muted, fontSize: 12, marginTop: 3 },
    detailHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      padding: 14,
      borderBottomWidth: 1,
      borderBottomColor: C.border,
      backgroundColor: C.surface,
    },
    detailTitle: { color: C.text, fontWeight: "600", fontSize: 16 },
    smallBtn: {
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    smallBtnText: { color: C.text, fontSize: 12, fontWeight: "600" },
    closeBtn: { padding: 6 },
    closeText: { color: C.muted, fontSize: 16 },
    canvasBox: {
      backgroundColor: "#fff",
      borderRadius: 10,
      borderWidth: 1,
      borderColor: C.border,
      overflow: "hidden",
      minHeight: 120,
    },
    summary: { color: C.text, fontSize: 14, lineHeight: 20, marginTop: 10 },
    commentsLabel: {
      color: C.muted,
      fontSize: 11,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginTop: 16,
      marginBottom: 8,
    },
    comment: {
      backgroundColor: C.surface,
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      marginBottom: 8,
    },
    commentBody: { color: C.text, fontSize: 14, marginTop: 2 },
    sendRow: {
      flexDirection: "row",
      gap: 8,
      padding: 12,
      borderTopWidth: 1,
      borderTopColor: C.border,
      backgroundColor: C.surface,
    },
    sendInput: {
      flex: 1,
      backgroundColor: C.surface2,
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 8,
      color: C.text,
      padding: 10,
    },
    sendBtn: {
      backgroundColor: C.accent,
      borderRadius: 8,
      paddingHorizontal: 16,
      justifyContent: "center",
    },
  });
