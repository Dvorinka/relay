import { useCallback, useEffect, useState, useMemo } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, useFocusEffect, useNavigation } from "expo-router";
import { api, type Project } from "../lib/api";
import { useTheme, type Palette } from "../lib/theme";

export default function Projects() {
  const C = useTheme();
  const s = useMemo(() => themedStyles(C), [C]);
  const [items, setItems] = useState<Project[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [pendRevs, setPendRevs] = useState<Record<string, number>>({});
  const nav = useNavigation();
  const inboxCount =
    Object.values(unread).reduce((a, b) => a + b, 0) +
    Object.values(pendRevs).reduce((a, b) => a + b, 0);

  useEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <Pressable onPress={() => router.push("/settings")} hitSlop={12}>
          <Text style={{ color: C.muted, fontSize: 20 }}>⚙</Text>
        </Pressable>
      ),
      headerLeft: () => (
        <Pressable
          onPress={() => router.push("/inbox")}
          hitSlop={12}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <Text style={{ color: C.muted, fontSize: 15 }}>Inbox</Text>
          {inboxCount > 0 && (
            <View
              style={{
                backgroundColor: C.accent,
                borderRadius: 9,
                minWidth: 18,
                paddingHorizontal: 5,
                alignItems: "center",
              }}
            >
              <Text
                style={{ color: C.onAccent, fontSize: 11, fontWeight: "700" }}
              >
                {inboxCount}
              </Text>
            </View>
          )}
        </Pressable>
      ),
    });
  }, [nav, C, inboxCount]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [r, u] = await Promise.all([api.projects(), api.unreadCounts()]);
      setItems(r.projects);
      setUnread(u.unread ?? {});
      setPendRevs(u.reviews ?? {});
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
      renderItem={({ item }) => {
        const badge = (unread[item.id] ?? 0) + (pendRevs[item.id] ?? 0);
        return (
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
            {badge > 0 && (
              <View style={s.badge}>
                <Text style={s.badgeText}>{badge}</Text>
              </View>
            )}
            <Text style={s.chev}>›</Text>
          </Pressable>
        );
      }}
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
  badge: {
    backgroundColor: C.accent,
    borderRadius: 9,
    minWidth: 18,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: C.onAccent, fontSize: 11, fontWeight: "700" },
  empty: { color: C.muted, textAlign: "center", marginTop: 60 },
});
