import { useCallback, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, type Issue } from "../../../lib/api";
import { C } from "../../../lib/theme";

const STATUSES = ["backlog", "todo", "in_progress", "review", "done"];
const LABEL: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

export default function IssuesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [items, setItems] = useState<Issue[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api.issues(id);
      setItems(r.issues);
    } finally {
      setRefreshing(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const advance = async (issue: Issue) => {
    const i = STATUSES.indexOf(issue.status);
    const next = STATUSES[(i + 1) % STATUSES.length];
    await api.updateIssue(issue.id, { status: next });
    load();
  };

  return (
    <FlatList
      data={items}
      keyExtractor={(i) => i.id}
      contentContainerStyle={{ padding: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={load}
          tintColor={C.accent}
        />
      }
      ListEmptyComponent={
        <Text style={s.empty}>No issues.</Text>
      }
      renderItem={({ item }) => (
        <View style={s.card}>
          <View style={{ flex: 1 }}>
            <Text style={s.key}>{item.key ?? `#${item.number}`}</Text>
            <Text style={s.title}>{item.title}</Text>
          </View>
          <Pressable style={s.status} onPress={() => advance(item)}>
            <Text style={s.statusText}>{LABEL[item.status] ?? item.status}</Text>
          </Pressable>
        </View>
      )}
    />
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    gap: 10,
  },
  key: { color: C.muted, fontSize: 12, fontWeight: "600" },
  title: { color: C.text, fontSize: 15, fontWeight: "500", marginTop: 2 },
  status: {
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusText: { color: C.accent, fontSize: 12, fontWeight: "600" },
  empty: { color: C.muted, textAlign: "center", marginTop: 60 },
});
