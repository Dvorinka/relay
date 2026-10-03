import { useCallback, useEffect, useState, useMemo } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
// expo-image forwards request headers; RN's Image drops them on Android.
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect, useNavigation } from "expo-router";
import {
  api,
  fileUrl,
  getCookie,
  getServer,
  type Message,
  type ThreadChip,
} from "../../lib/api";
import {
  drainOutbox,
  enqueueMessage,
  outboxFor,
  subscribeOutbox,
  type QueuedMessage,
} from "../../lib/outbox";
import { useTheme, type Palette } from "../../lib/theme";

interface LocalPick {
  uri: string;
  name: string;
  type: string;
}

const QUICK_EMOJI = ["👀", "✅", "❤️", "🎉", "👍"];
const GROUP_GAP_MS = 5 * 60 * 1000;

type Row =
  | { type: "day"; key: string; label: string }
  | { type: "msg"; key: string; msg: Message; first: boolean };

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Chronological rows: day separators + first-of-group flags. Reversed for the
// inverted list at render time.
function buildRows(messages: Message[]): Row[] {
  const rows: Row[] = [];
  let prev: Message | null = null;
  let prevDay = "";
  for (const m of messages) {
    const day = new Date(m.created_at).toDateString();
    if (day !== prevDay) {
      rows.push({ type: "day", key: `day-${day}`, label: dayLabel(m.created_at) });
      prevDay = day;
      prev = null;
    }
    const grouped =
      prev !== null &&
      prev.author.id === m.author.id &&
      prev.author.kind === m.author.kind &&
      new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() <
        GROUP_GAP_MS;
    rows.push({ type: "msg", key: m.id, msg: m, first: !grouped });
    prev = m;
  }
  return rows;
}

// Minimal markdown: fenced blocks + **bold** / `code` / *italic* inline runs.
function inlineRuns(text: string): { text: string; bold?: boolean; italic?: boolean; code?: boolean }[] {
  const out: { text: string; bold?: boolean; italic?: boolean; code?: boolean }[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const tok = m[0];
    if (tok.startsWith("**")) out.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith("`")) out.push({ text: tok.slice(1, -1), code: true });
    else out.push({ text: tok.slice(1, -1), italic: true });
    last = m.index + tok.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function RichBody({ text, C, s }: { text: string; C: Palette; s: ReturnType<typeof themedStyles> }) {
  const blocks: { code: boolean; text: string }[] = [];
  const re = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) blocks.push({ code: false, text: text.slice(last, m.index) });
    blocks.push({ code: true, text: m[2].replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) blocks.push({ code: false, text: text.slice(last) });

  return (
    <View>
      {blocks.map((b, i) =>
        b.code ? (
          <View key={i} style={s.codeBlock}>
            <Text style={s.codeText} selectable>
              {b.text}
            </Text>
          </View>
        ) : (
          <Text key={i} style={s.body} selectable>
            {inlineRuns(b.text).map((r, j) => (
              <Text
                key={j}
                style={[
                  r.bold && { fontWeight: "700" },
                  r.italic && { fontStyle: "italic" },
                  r.code && s.inlineCode,
                ]}
              >
                {r.text}
              </Text>
            ))}
          </Text>
        ),
      )}
    </View>
  );
}

// Shared chat surface: a project's main conversation, or a message-rooted
// thread when `conversationId` is passed. `inThread` hides the project tab
// bar and thread affordances (threads cannot nest).
export function ConversationScreen(props: {
  projectId: string;
  conversationId?: string;
  title?: string;
  inThread?: boolean;
}) {
  const id = props.projectId;
  const C = useTheme();
  const s = useMemo(() => themedStyles(C), [C]);
  const nav = useNavigation();
  const [convId, setConvId] = useState(props.conversationId ?? "");
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [meId, setMeId] = useState("");
  const [pending, setPending] = useState<LocalPick[]>([]);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [sheetFor, setSheetFor] = useState<Message | null>(null);

  const load = useCallback(async () => {
    try {
      let cid = props.conversationId;
      if (!cid) {
        const c = await api.conversation(id);
        cid = c.id;
        setConvId(cid);
        if (c.title) nav.setOptions({ title: c.title });
      }
      const m = await api.messages(cid);
      setMessages(m.messages);
      // a successful round-trip means we're online — flush the outbox
      void drainOutbox();
    } catch {
      // transient poll failure — the 4s timer retries
    }
  }, [id, nav, props.conversationId]);

  useEffect(() => {
    api.me().then((r) => setMeId(r.user.id)).catch(() => {});
  }, []);

  useEffect(() => {
    if (props.title) nav.setOptions({ title: props.title });
  }, [props.title, nav]);

  const refreshQueued = useCallback(() => {
    void outboxFor(id).then(setQueued);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
      refreshQueued();
      const t = setInterval(() => {
        void load().then(refreshQueued);
      }, 4000);
      const unsub = subscribeOutbox(refreshQueued);
      return () => {
        clearInterval(t);
        unsub();
      };
    }, [load, refreshQueued]),
  );

  // Picks stay local until send — the photo survives an offline compose.
  const pick = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({
      quality: 0.9,
      allowsMultipleSelection: true,
    });
    for (const a of r.assets ?? []) {
      setPending((p) => [
        ...p,
        {
          uri: a.uri,
          name: a.fileName ?? "image.jpg",
          type: a.mimeType ?? "image/jpeg",
        },
      ]);
    }
  };

  const send = async () => {
    const text = body.trim();
    if (!convId || busy) return;
    setBusy(true);
    try {
      if (editing) {
        if (!text) return;
        await api.editMessage(editing.id, text);
        setEditing(null);
      } else {
        if (!text && pending.length === 0) return;
        try {
          const ids: string[] = [];
          for (const p of pending) {
            const att = await api.upload(id, p);
            ids.push(att.id);
          }
          await api.postMessage(convId, text, ids, replyTo?.id);
        } catch {
          // Offline or server down — stage the message, uploads included,
          // and let the poll-driven drain deliver it later.
          await enqueueMessage({
            projectId: id,
            conversationId: convId,
            body: text,
            replyTo: replyTo?.id,
            files: pending,
          });
          refreshQueued();
        }
        setPending([]);
        setReplyTo(null);
      }
      setBody("");
      await load();
    } catch (e) {
      Alert.alert("Send failed", e instanceof Error ? e.message : "try again");
    } finally {
      setBusy(false);
    }
  };

  const react = async (msg: Message, emoji: string) => {
    setSheetFor(null);
    try {
      const r = await api.reactMessage(msg.id, emoji);
      setMessages((ms) =>
        ms.map((m) => (m.id === msg.id ? { ...m, reactions: r.reactions } : m)),
      );
    } catch {
      // reaction lost — next poll reconciles
    }
  };

  const startEdit = (msg: Message) => {
    setSheetFor(null);
    setReplyTo(null);
    setEditing(msg);
    setBody(msg.body);
  };

  const startReply = (msg: Message) => {
    setSheetFor(null);
    setEditing(null);
    setBody("");
    setReplyTo(msg);
  };

  const openThread = (t: ThreadChip) => {
    setSheetFor(null);
    router.push({
      pathname: "/p/[id]/thread",
      params: { id, cid: t.id, title: t.title ?? "Thread" },
    });
  };

  const startThread = async (msg: Message) => {
    setSheetFor(null);
    try {
      const { thread } = await api.createThread(msg.id);
      openThread(thread);
    } catch (e) {
      Alert.alert(
        "Could not create thread",
        e instanceof Error ? e.message : "try again",
      );
    }
  };

  const rows = useMemo(() => buildRows(messages).reverse(), [messages]);
  const canEdit = (m: Message) =>
    m.author.kind === "user" && m.author.id === meId && !m.agent_read;
  const canDelete = canEdit; // same agent-read lock as edit

  const removeMessage = (mid: string) =>
    setMessages((ms) =>
      ms
        .filter((x) => x.id !== mid)
        .map((x) =>
          x.parent?.id === mid
            ? { ...x, parent: { ...x.parent, deleted: true } }
            : x,
        ),
    );

  const confirmDelete = (msg: Message) => {
    setSheetFor(null);
    Alert.alert(
      "Delete message?",
      "This removes it for everyone. Replies keep a 'deleted' placeholder.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await api.deleteMessage(msg.id);
              removeMessage(msg.id);
            } catch (e) {
              Alert.alert(
                "Delete failed",
                e instanceof Error ? e.message : "try again",
              );
            }
          },
        },
      ],
    );
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {!props.inThread && (
        <View style={s.tabs}>
          <Pressable onPress={() => router.push(`/p/${id}/issues`)}>
            <Text style={s.tab}>Issues</Text>
          </Pressable>
          <Pressable onPress={() => router.push(`/p/${id}/reviews`)}>
            <Text style={s.tab}>Reviews</Text>
          </Pressable>
          <Pressable onPress={() => router.push(`/p/${id}/briefs`)}>
            <Text style={s.tab}>Briefs</Text>
          </Pressable>
          <Pressable onPress={() => router.push(`/p/${id}/todos`)}>
            <Text style={s.tab}>Work list</Text>
          </Pressable>
        </View>
      )}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={{ padding: 12, paddingTop: 16 }}
        inverted
        renderItem={({ item }) => {
          if (item.type === "day") {
            return (
              <View style={s.dayRow}>
                <View style={s.dayLine} />
                <Text style={s.dayText}>{item.label}</Text>
                <View style={s.dayLine} />
              </View>
            );
          }
          const m = item.msg;
          const avatar = fileUrl(m.author.avatar_url);
          return (
            <Pressable onLongPress={() => setSheetFor(m)} delayLongPress={350}>
              <View style={[s.msg, !item.first && s.msgGrouped]}>
                {item.first ? (
                  avatar ? (
                    <Image
                      source={{ uri: avatar, headers: { cookie: getCookie() } }}
                      style={s.avatar}
                    />
                  ) : (
                    <View style={[s.avatar, s.avatarFallback]}>
                      <Text style={s.avatarLetter}>
                        {m.author.name.slice(0, 1).toUpperCase()}
                      </Text>
                    </View>
                  )
                ) : (
                  <View style={s.avatarSpacer} />
                )}
                <View style={s.msgBody}>
                  {item.first && (
                    <View style={s.msgHead}>
                      <Text style={s.author}>{m.author.name}</Text>
                      {m.author.kind === "agent" && (
                        <Text style={s.agentBadge}>AGENT</Text>
                      )}
                      <Text style={s.time}>{timeLabel(m.created_at)}</Text>
                    </View>
                  )}
                  {m.parent && (
                    <View style={s.replyStrip}>
                      <Text style={s.replyText} numberOfLines={1}>
                        ↳ {m.parent.deleted ? "deleted" : m.parent.author}
                        {m.parent.preview ? ` · ${m.parent.preview}` : ""}
                      </Text>
                    </View>
                  )}
                  {m.body ? <RichBody text={m.body} C={C} s={s} /> : null}
                  {m.edited_at ? (
                    <Text style={s.edited}>(edited)</Text>
                  ) : null}
                  {(m.attachments ?? []).map((a) =>
                    a.content_type.startsWith("image/") ? (
                      <Image
                        key={a.id}
                        source={{
                          uri: `${getServer()}/api/projects/${id}/attachments/${a.id}/download`,
                          headers: { cookie: getCookie() },
                        }}
                        style={s.img}
                        contentFit="cover"
                      />
                    ) : (
                      <Text key={a.id} style={s.file}>
                        📎 {a.filename}
                      </Text>
                    ),
                  )}
                  {(m.reactions ?? []).length > 0 && (
                    <View style={s.reactions}>
                      {(m.reactions ?? []).map((r) => (
                        <Pressable
                          key={r.emoji}
                          style={[s.rxn, r.mine && s.rxnMine]}
                          onPress={() => react(m, r.emoji)}
                        >
                          <Text style={s.rxnText}>
                            {r.emoji} {r.count}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                  {m.thread && !props.inThread && (
                    <Pressable
                      style={s.threadChip}
                      onPress={() => openThread(m.thread!)}
                    >
                      <Text style={s.threadText} numberOfLines={1}>
                        🧵 {m.thread.title || "Thread"} ·{" "}
                        {m.thread.reply_count}{" "}
                        {m.thread.reply_count === 1 ? "reply" : "replies"}
                      </Text>
                    </Pressable>
                  )}
                </View>
              </View>
            </Pressable>
          );
        }}
        ListFooterComponent={
          <View>
            {messages.length === 0 && queued.length === 0 ? (
              <ActivityIndicator color={C.accent} style={{ marginTop: 40 }} />
            ) : null}
            {queued.map((qm) => (
              <View key={qm.id} style={s.queuedRow}>
                <Text style={s.queuedText} numberOfLines={2}>
                  {qm.body ||
                    `${qm.files.length} attachment${qm.files.length === 1 ? "" : "s"}`}
                </Text>
                <Text style={s.queuedTag}>
                  queued — sends when you are back online
                </Text>
              </View>
            ))}
          </View>
        }
      />
      {pending.length > 0 && (
        <View style={s.pendingStrip}>
          {pending.map((p) => (
            <View key={p.uri} style={s.pendingChip}>
              <Image
                source={{ uri: p.uri }}
                style={s.pendingThumb}
              />
              <Text style={s.pendingName} numberOfLines={1}>
                {p.name}
              </Text>
              <Pressable
                onPress={() => setPending((l) => l.filter((x) => x.uri !== p.uri))}
                hitSlop={8}
              >
                <Text style={s.pendingX}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {(replyTo || editing) && (
        <View style={s.modeStrip}>
          <Text style={s.modeText} numberOfLines={1}>
            {editing
              ? `Editing — ${editing.body.slice(0, 60)}`
              : `Replying to ${replyTo?.author.name}`}
          </Text>
          <Pressable
            onPress={() => {
              setEditing(null);
              setReplyTo(null);
              setBody("");
            }}
            hitSlop={8}
          >
            <Text style={s.modeX}>✕</Text>
          </Pressable>
        </View>
      )}
      <View style={s.composer}>
        <Pressable style={s.attachBtn} onPress={pick}>
          <Text style={s.attachText}>+</Text>
        </Pressable>
        <TextInput
          style={s.input}
          placeholder={editing ? "Edit message" : "Message"}
          placeholderTextColor={C.muted}
          value={body}
          onChangeText={setBody}
          multiline
          submitBehavior={editing ? "submit" : "newline"}
          returnKeyType={editing ? "done" : "send"}
          onSubmitEditing={editing ? send : undefined}
        />
        <Pressable
          style={[
            s.send,
            ((!body.trim() && pending.length === 0) || busy) && { opacity: 0.4 },
          ]}
          onPress={send}
          disabled={(!body.trim() && pending.length === 0) || busy}
        >
          <Text style={s.sendText}>{editing ? "Save" : "Send"}</Text>
        </Pressable>
      </View>

      <Modal
        visible={sheetFor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setSheetFor(null)}
      >
        <Pressable style={s.sheetBg} onPress={() => setSheetFor(null)}>
          <View style={s.sheet}>
            <View style={s.emojiRow}>
              {QUICK_EMOJI.map((e) => (
                <Pressable
                  key={e}
                  style={s.emojiBtn}
                  onPress={() => sheetFor && react(sheetFor, e)}
                >
                  <Text style={{ fontSize: 22 }}>{e}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable style={s.sheetBtn} onPress={() => sheetFor && startReply(sheetFor)}>
              <Text style={s.sheetBtnText}>Reply</Text>
            </Pressable>
            {!props.inThread && sheetFor && !sheetFor.thread && (
              <Pressable
                style={s.sheetBtn}
                onPress={() => startThread(sheetFor)}
              >
                <Text style={s.sheetBtnText}>Create thread</Text>
              </Pressable>
            )}
            {!props.inThread && sheetFor?.thread && (
              <Pressable
                style={s.sheetBtn}
                onPress={() => openThread(sheetFor.thread!)}
              >
                <Text style={s.sheetBtnText}>Open thread</Text>
              </Pressable>
            )}
            {sheetFor && canEdit(sheetFor) && (
              <Pressable style={s.sheetBtn} onPress={() => startEdit(sheetFor)}>
                <Text style={s.sheetBtnText}>Edit</Text>
              </Pressable>
            )}
            {sheetFor && canDelete(sheetFor) && (
              <Pressable
                style={s.sheetBtn}
                onPress={() => confirmDelete(sheetFor)}
              >
                <Text style={[s.sheetBtnText, { color: "#EF4444" }]}>
                  Delete
                </Text>
              </Pressable>
            )}
            {sheetFor &&
              sheetFor.author.kind === "user" &&
              sheetFor.author.id === meId &&
              sheetFor.agent_read && (
                <Text style={s.sheetHint}>
                  Seen by an agent — editing and deletion locked
                </Text>
              )}
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const themedStyles = (C: Palette) =>
  StyleSheet.create({
    tabs: {
      flexDirection: "row",
      gap: 18,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomColor: C.border,
      borderBottomWidth: 1,
    },
    tab: { color: C.accent, fontWeight: "600" },
    dayRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginVertical: 14,
    },
    dayLine: { flex: 1, height: 1, backgroundColor: C.border },
    dayText: { color: C.faint, fontSize: 11, fontWeight: "600" },
    msg: { flexDirection: "row", gap: 10, marginBottom: 2 },
    msgGrouped: {},
    msgBody: { flex: 1, minWidth: 0 },
    avatar: { width: 38, height: 38, borderRadius: 19, marginTop: 2 },
    avatarFallback: {
      backgroundColor: C.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarLetter: { color: C.onAccent, fontWeight: "700", fontSize: 15 },
    avatarSpacer: { width: 38 },
    msgHead: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
    author: { color: C.text, fontWeight: "600", fontSize: 14 },
    agentBadge: {
      color: C.accent,
      fontSize: 9,
      fontWeight: "700",
      borderWidth: 1,
      borderColor: C.accent,
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 1,
    },
    time: { color: C.faint, fontSize: 11 },
    replyStrip: {
      borderLeftColor: C.accent,
      borderLeftWidth: 3,
      paddingLeft: 8,
      marginTop: 4,
    },
    replyText: { color: C.muted, fontSize: 12 },
    body: { color: C.text, marginTop: 2, fontSize: 15, lineHeight: 22 },
    inlineCode: {
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      backgroundColor: C.surface2,
      fontSize: 13,
    },
    codeBlock: {
      backgroundColor: C.scheme === "dark" ? "#060607" : C.surface2,
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      marginTop: 6,
    },
    codeText: {
      color: C.text,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      fontSize: 13,
      lineHeight: 19,
    },
    edited: { color: C.faint, fontSize: 10, marginTop: 2 },
    img: { width: "100%", height: 220, borderRadius: 10, marginTop: 8 },
    file: { color: C.muted, marginTop: 6 },
    reactions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
    rxn: {
      borderWidth: 1,
      borderColor: C.border,
      borderRadius: 12,
      paddingHorizontal: 8,
      paddingVertical: 3,
      backgroundColor: C.surface,
    },
    rxnMine: { borderColor: C.accent, backgroundColor: C.surface2 },
    rxnText: { color: C.text, fontSize: 13 },
    threadChip: {
      borderLeftColor: C.accent,
      borderLeftWidth: 3,
      paddingLeft: 8,
      marginTop: 6,
      paddingVertical: 4,
    },
    threadText: { color: C.accent, fontSize: 12.5, fontWeight: "500" },
    pendingStrip: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderTopColor: C.border,
      borderTopWidth: 1,
      backgroundColor: C.bg,
    },
    pendingChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: C.surface,
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 10,
      padding: 6,
      maxWidth: 220,
    },
    pendingThumb: { width: 32, height: 32, borderRadius: 6 },
    pendingName: { color: C.text, fontSize: 12, flexShrink: 1 },
    pendingX: { color: C.muted, fontSize: 14, paddingHorizontal: 4 },
    queuedRow: {
      marginHorizontal: 12,
      marginTop: 8,
      padding: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: C.border,
      backgroundColor: C.surface,
      opacity: 0.85,
    },
    queuedText: { color: C.text, fontSize: 13.5 },
    queuedTag: { color: C.muted, fontSize: 11, marginTop: 4, fontStyle: "italic" },
    modeStrip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderTopColor: C.border,
      borderTopWidth: 1,
      backgroundColor: C.surface2,
    },
    modeText: { color: C.muted, fontSize: 12, flex: 1 },
    modeX: { color: C.muted, fontSize: 14 },
    composer: {
      flexDirection: "row",
      alignItems: "flex-end",
      padding: 10,
      gap: 8,
      borderTopColor: C.border,
      borderTopWidth: 1,
      backgroundColor: C.bg,
    },
    attachBtn: {
      width: 40,
      height: 40,
      borderRadius: 10,
      backgroundColor: C.surface,
      borderColor: C.border,
      borderWidth: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    attachText: { color: C.text, fontSize: 22, marginTop: -2 },
    input: {
      flex: 1,
      backgroundColor: C.surface,
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 10,
      color: C.text,
      padding: 10,
      maxHeight: 100,
    },
    send: {
      backgroundColor: C.accent,
      borderRadius: 10,
      paddingHorizontal: 16,
      height: 40,
      justifyContent: "center",
    },
    sendText: { color: C.onAccent, fontWeight: "600" },
    sheetBg: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: C.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      padding: 16,
      paddingBottom: 32,
      gap: 4,
    },
    emojiRow: {
      flexDirection: "row",
      justifyContent: "space-around",
      paddingBottom: 12,
      marginBottom: 8,
      borderBottomColor: C.border,
      borderBottomWidth: 1,
    },
    emojiBtn: { padding: 8 },
    sheetBtn: { paddingVertical: 14, paddingHorizontal: 6 },
    sheetBtnText: { color: C.text, fontSize: 16, fontWeight: "500" },
    sheetHint: { color: C.faint, fontSize: 12, paddingHorizontal: 6, paddingTop: 6 },
  });
