import { useCallback, useState, useMemo} from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, type Todo } from "../../../lib/api";
import { useTheme, type Palette } from "../../../lib/theme";

export default function TodosScreen() {
  const C = useTheme();
  const s = useMemo(() => themedStyles(C), [C]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const [items, setItems] = useState<Todo[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api.todos(id);
      setItems(r.todos);
    } finally {
      setRefreshing(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <FlatList
      data={items}
      keyExtractor={(t) => t.id}
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
          No todos. Agents create them through MCP.
        </Text>
      }
      renderItem={({ item }) => (
        <View style={s.card}>
          <Text style={[s.title, item.done && s.done]}>{item.content}</Text>
          <View style={[s.dot, item.done && s.dotDone]} />
        </View>
      )}
    />
  );
}

const themedStyles = (C: Palette) => StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.surface,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  title: { flex: 1, color: C.text, fontSize: 15 },
  done: { color: C.muted, textDecorationLine: "line-through" },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: C.muted,
  },
  dotDone: { borderColor: C.accent, backgroundColor: C.accent },
  empty: { color: C.muted, textAlign: "center", marginTop: 60 },
});
