import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  router,
  useFocusEffect,
  useLocalSearchParams,
  useNavigation,
} from "expo-router";
import { api, getCookie, getServer, type Message } from "../../../lib/api";
import { C } from "../../../lib/theme";

export default function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const nav = useNavigation();
  const [convId, setConvId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await api.conversation(id);
      setConvId(c.id);
      const m = await api.messages(c.id);
      setMessages(m.messages);
    } catch {
      // transient poll failure — the 4s timer retries
    }
  }, [id]);

  useEffect(() => {
    nav.setOptions({ title: "Conversation" });
  }, [nav]);

  useFocusEffect(
    useCallback(() => {
      void load();
      const t = setInterval(load, 4000);
      return () => clearInterval(t);
    }, [load]),
  );

  const pick = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ quality: 0.9 });
    const a = r.assets?.[0];
    if (!a) return;
    const name = a.fileName ?? "image.jpg";
    const type = a.mimeType ?? "image/jpeg";
    const att = await api.upload({ uri: a.uri, name, type });
    if (!convId) return;
    await api.postMessage(convId, att.filename, [att.id]);
    await load();
  };

  const send = async () => {
    const text = body.trim();
    if (!text || !convId) return;
    setBusy(true);
    try {
      await api.postMessage(convId, text);
      setBody("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={s.tabs}>
        <Pressable onPress={() => router.push(`/p/${id}/issues`)}>
          <Text style={s.tab}>Issues</Text>
        </Pressable>
        <Pressable onPress={() => router.push(`/p/${id}/todos`)}>
          <Text style={s.tab}>Work list</Text>
        </Pressable>
      </View>
      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12 }}
        inverted
        renderItem={({ item }) => (
          <View style={s.msg}>
            <View style={s.msgHead}>
              <Text style={s.author}>{item.author?.name}</Text>
              {item.author?.kind === "agent" ? (
                <Text style={s.agentBadge}>AGENT</Text>
              ) : null}
              <Text style={s.time}>
                {new Date(item.created_at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Text>
            </View>
            {item.body ? <Text style={s.body}>{item.body}</Text> : null}
            {(item.attachments ?? []).map((a) =>
              a.content_type.startsWith("image/") ? (
                <Image
                  key={a.id}
                  source={{
                    uri: `${getServer()}/api/attachments/${a.id}/url`,
                    headers: { cookie: getCookie() },
                  }}
                  style={s.img}
                  resizeMode="cover"
                />
              ) : (
                <Text key={a.id} style={s.file}>
                  📎 {a.filename}
                </Text>
              ),
            )}
          </View>
        )}
        ListFooterComponent={
          messages.length === 0 ? (
            <ActivityIndicator color={C.accent} style={{ marginTop: 40 }} />
          ) : null
        }
      />
      <View style={s.composer}>
        <Pressable style={s.attachBtn} onPress={pick}>
          <Text style={s.attachText}>+</Text>
        </Pressable>
        <TextInput
          style={s.input}
          placeholder="Message"
          placeholderTextColor={C.muted}
          value={body}
          onChangeText={setBody}
          multiline
          submitBehavior="submit"
          returnKeyType="send"
          onSubmitEditing={send}
        />
        <Pressable
          style={[s.send, (!body.trim() || busy) && { opacity: 0.4 }]}
          onPress={send}
          disabled={!body.trim() || busy}
        >
          <Text style={s.sendText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tabs: {
    flexDirection: "row",
    gap: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomColor: C.border,
    borderBottomWidth: 1,
  },
  tab: { color: C.accent, fontWeight: "600" },
  msg: {
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  msgHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  author: { color: C.text, fontWeight: "600", fontSize: 13 },
  agentBadge: {
    color: C.accent,
    fontSize: 10,
    fontWeight: "700",
    borderWidth: 1,
    borderColor: C.accent,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  time: { color: C.muted, fontSize: 11, marginLeft: "auto" },
  body: { color: C.text, marginTop: 4, fontSize: 14, lineHeight: 20 },
  img: { width: "100%", height: 200, borderRadius: 8, marginTop: 8 },
  file: { color: C.muted, marginTop: 6 },
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
  sendText: { color: "#fff", fontWeight: "600" },
});
