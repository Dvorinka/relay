import { File } from "expo-file-system";
import { useEffect, useMemo, useState } from "react";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ShareIntentFile } from "expo-share-intent";

import { apiGet, apiPost, loadSessionToken } from "./lib/relay";

const MAX_BYTES = 25 * 1024 * 1024;

type Project = { id: string; name: string; key: string };

type Props = {
  server: string;
  files: ShareIntentFile[];
  text: string | null;
  onDone: (projectId: string | null) => void;
};

// ShareSheet is the Android share-target UI: pick a project, optionally
// caption the content, and the sheet uploads files (base64 JSON transport,
// same as the desktop bridge) and posts one message into the project's
// conversation.
export function ShareSheet({ server, files, text, onDone }: Props) {
  const insets = useSafeAreaInsets();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [caption, setCaption] = useState(text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usable = useMemo(
    () => files.filter((f) => !f.size || f.size <= MAX_BYTES),
    [files],
  );
  const skipped = files.length - usable.length;

  useEffect(() => {
    apiGet<{ projects: Project[] }>(server, "/api/projects")
      .then((r) => {
        setProjects(r.projects);
        if (r.projects.length === 1) setProjectId(r.projects[0].id);
      })
      .catch((e: Error) =>
        setError(
          e.message === "auth"
            ? "Open Relay and sign in first — sharing needs your session."
            : "Could not load projects.",
        ),
      );
  }, [server]);

  async function send() {
    if (!projectId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await loadSessionToken();
      if (!token) throw new Error("auth");
      const ids: string[] = [];
      for (const f of usable) {
        const data = await new File(f.path).base64();
        const att = await apiPost<{ id: string }>(
          server,
          `/api/projects/${projectId}/attachments`,
          { name: f.fileName || "shared-file", data },
        );
        ids.push(att.id);
      }
      const body =
        caption.trim() ||
        (usable.length
          ? usable.map((_, i) => `[image ${i + 1}]`).join(" ")
          : "(shared)");
      const conv = await apiGet<{ id: string }>(
        server,
        `/api/projects/${projectId}/conversation`,
      );
      await apiPost(server, `/api/conversations/${conv.id}/messages`, {
        body,
        attachment_ids: ids,
      });
      onDone(projectId);
    } catch (e) {
      setError(
        e instanceof Error && e.message === "auth"
          ? "Session expired — open Relay and sign in again."
          : "Send failed — check the connection and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <View style={[styles.overlay, { paddingTop: insets.top }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheet}
      >
        <Text style={styles.title}>Share to Relay</Text>

        {usable.length > 0 && (
          <View style={styles.thumbs}>
            {usable.slice(0, 5).map((f, i) =>
              f.mimeType?.startsWith("image/") ? (
                <Image
                  key={i}
                  source={{ uri: f.path }}
                  style={styles.thumb}
                  resizeMode="cover"
                />
              ) : (
                <View key={i} style={[styles.thumb, styles.thumbFile]}>
                  <Text style={styles.thumbFileText} numberOfLines={2}>
                    {f.fileName || "file"}
                  </Text>
                </View>
              ),
            )}
          </View>
        )}
        {skipped > 0 && (
          <Text style={styles.hint}>
            {skipped} file{skipped > 1 ? "s" : ""} over 25 MiB skipped
          </Text>
        )}

        <TextInput
          style={styles.caption}
          value={caption}
          onChangeText={setCaption}
          placeholder="Add a note…"
          placeholderTextColor="#6b6e75"
          multiline
        />

        {projects === null && !error && (
          <ActivityIndicator color="#06b6d4" style={{ marginVertical: 16 }} />
        )}
        <FlatList
          data={projects ?? []}
          keyExtractor={(p) => p.id}
          style={styles.list}
          renderItem={({ item }) => (
            <Pressable
              style={[
                styles.project,
                item.id === projectId && styles.projectActive,
              ]}
              onPress={() => setProjectId(item.id)}
            >
              <Text style={styles.projectKey}>{item.key}</Text>
              <Text style={styles.projectName} numberOfLines={1}>
                {item.name}
              </Text>
            </Pressable>
          )}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <View style={styles.row}>
          <Pressable
            style={styles.btnGhost}
            onPress={() => onDone(null)}
            disabled={busy}
          >
            <Text style={styles.btnGhostText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, (!projectId || busy) && { opacity: 0.4 }]}
            onPress={send}
            disabled={!projectId || busy}
          >
            {busy ? (
              <ActivityIndicator color="#062a30" />
            ) : (
              <Text style={styles.btnText}>Send</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#0a0a0b",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#131416",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    maxHeight: "82%",
    borderWidth: 1,
    borderColor: "#232427",
  },
  title: {
    color: "#e9e9eb",
    fontSize: 17,
    fontWeight: "600",
    marginBottom: 12,
  },
  thumbs: { flexDirection: "row", gap: 8, marginBottom: 10 },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: "#1b1c1f" },
  thumbFile: { alignItems: "center", justifyContent: "center", padding: 4 },
  thumbFileText: { color: "#9c9fa7", fontSize: 9, textAlign: "center" },
  hint: { color: "#9c9fa7", fontSize: 12, marginBottom: 8 },
  caption: {
    borderWidth: 1,
    borderColor: "#232427",
    borderRadius: 10,
    color: "#e9e9eb",
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    minHeight: 40,
    maxHeight: 90,
    marginBottom: 10,
  },
  list: { maxHeight: 180, marginBottom: 8 },
  project: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  projectActive: { backgroundColor: "#0f2a30" },
  projectKey: {
    color: "#06b6d4",
    fontSize: 12,
    fontWeight: "700",
    width: 40,
  },
  projectName: { color: "#e9e9eb", fontSize: 14, flex: 1 },
  error: { color: "#e0655f", fontSize: 13, marginBottom: 8 },
  row: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
  btnGhost: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#232427",
  },
  btnGhostText: { color: "#9c9fa7", fontSize: 14 },
  btn: {
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#06b6d4",
    minWidth: 84,
    alignItems: "center",
  },
  btnText: { color: "#062a30", fontSize: 14, fontWeight: "600" },
});
