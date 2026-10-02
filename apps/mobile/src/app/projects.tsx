import { useCallback, useState, useMemo} from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, type Project } from "../lib/api";
import { useTheme, type Palette } from "../lib/theme";

export default function Projects() {
  const C = useTheme();
  const s = useMemo(() => themedStyles(C), [C]);
  const [items, setItems] = useState<Project[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await api.projects();
      setItems(r.projects);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <FlatList
      data={items}
      keyExtractor={(p) => p.id}
      contentContainerStyle={{ padding: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={load}
          tintColor={C.accent}
        />
      }
      ListEmptyComponent={
        <Text style={s.empty}>No projects. Create one in the web app.</Text>
      }
      renderItem={({ item }) => (
        <Pressable
          style={s.card}
          onPress={() => router.push(`/p/${item.id}`)}
        >
          <View style={s.key}>
            <Text style={s.keyText}>{item.key.slice(0, 2)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.name}>{item.name}</Text>
            <Text style={s.muted}>{item.key}</Text>
          </View>
          <Text style={s.chev}>›</Text>
        </Pressable>
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
    gap: 12,
  },
  key: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  keyText: { color: C.onAccent, fontWeight: "700" },
  name: { color: C.text, fontWeight: "600", fontSize: 16 },
  muted: { color: C.muted, fontSize: 12 },
  chev: { color: C.muted, fontSize: 24 },
  empty: { color: C.muted, textAlign: "center", marginTop: 60 },
});
