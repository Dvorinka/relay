import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { router, useFocusEffect } from "expo-router";
import {
  api,
  getCookie,
  getServer,
  type Mention,
  type MyReview,
} from "../lib/api";
import { useTheme, type Palette } from "../lib/theme";

type Row =
  | { type: "h"; key: string; label: string; count?: number }
  | { type: "review"; key: string; review: MyReview }
  | { type: "mention"; key: string; mention: Mention };

function Avatar({
  name,
  url,
  C,
  s,
}: {
  name: string;
  url: string | null;
  C: Palette;
  s: ReturnType<typeof themedStyles>;
}) {
  if (url) {
    return (
      <Image
        source={{ uri: url, headers: { cookie: getCookie() } }}
        style={s.avatar}
      />
    );
  }
  return (
    <View style={[s.avatar, s.avatarFallback]}>
      <Text style={s.avatarLetter}>{name.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

export default function Inbox() {
  const C = useTheme();
  const s = useMemo(() => themedStyles(C), [C]);
  const [reviews, setReviews] = useState<MyReview[]>([]);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [r, m] = await Promise.all([api.myReviews(), api.mentions()]);
      setReviews(r.reviews);
      setMentions(m.mentions);
    } catch {
      // transient
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    if (reviews.length > 0) {
      out.push({
        type: "h",
        key: "h-rev",
        label: "Awaiting your verdict",
        count: reviews.length,
      });
      for (const r of reviews) out.push({ type: "review", key: r.id, review: r });
    }
    if (mentions.length > 0) {
      out.push({ type: "h", key: "h-men", label: "Mentions", count: mentions.length });
      for (const m of mentions)
        out.push({ type: "mention", key: m.id, mention: m });
    }
    return out;
  }, [reviews, mentions]);

  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.key}
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
          All caught up. Reviews and mentions land here.
        </Text>
      }
      renderItem={({ item }) => {
        if (item.type === "h") {
          return (
            <Text style={s.section}>
              {item.label}
              {item.count ? `  ${item.count}` : ""}
            </Text>
          );
        }
        if (item.type === "review") {
          const r = item.review;
          const avatar = r.agent?.avatar_url
            ? getServer() + r.agent.avatar_url
            : null;
          return (
            <Pressable
              style={[s.card, s.reviewCard]}
              onPress={() => router.push(`/p/${r.project_id}/reviews`)}
            >
              <Avatar name={r.agent?.name ?? "A"} url={avatar} C={C} s={s} />
              <View style={{ flex: 1 }}>
                <Text style={s.title}>{r.title}</Text>
                <Text style={s.muted}>
                  {r.agent?.name} · {r.project_name} {r.project_key}
                </Text>
              </View>
              <Text style={s.chev}>›</Text>
            </Pressable>
          );
        }
        const m = item.mention;
        const avatar = m.author.avatar
          ? `${getServer()}/api/files/${m.author.avatar}`
          : null;
        return (
          <Pressable
            style={s.card}
            onPress={() => {
              if (!m.is_read) void api.markMessageRead(m.id);
              if (m.issue_id) {
                router.push(`/p/${m.project_id}/issues`);
              } else if (m.conversation_kind === "thread") {
                router.push(
                  `/p/${m.project_id}/thread?cid=${m.conversation_id}`,
                );
              } else {
                router.push(`/p/${m.project_id}`);
              }
            }}
          >
            <Avatar name={m.author.name} url={avatar} C={C} s={s} />
            <View style={{ flex: 1 }}>
              <Text style={s.title}>
                {m.author.name}
                {m.author.kind === "agent" ? "  AGENT" : ""}
              </Text>
              <Text style={s.muted} numberOfLines={2}>
                {m.body}
              </Text>
            </View>
            <Text style={s.chev}>›</Text>
          </Pressable>
        );
      }}
    />
  );
}

const themedStyles = (C: Palette) =>
  StyleSheet.create({
    section: {
      color: C.faint,
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.8,
      textTransform: "uppercase",
      marginTop: 14,
      marginBottom: 8,
      marginLeft: 4,
    },
    card: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: C.surface,
      borderColor: C.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 12,
      marginBottom: 8,
      gap: 10,
    },
    reviewCard: { borderLeftColor: "#8b5cf6", borderLeftWidth: 3 },
    avatar: { width: 32, height: 32, borderRadius: 16 },
    avatarFallback: {
      backgroundColor: C.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarLetter: { color: C.onAccent, fontWeight: "700", fontSize: 13 },
    title: { color: C.text, fontWeight: "600", fontSize: 14 },
    muted: { color: C.muted, fontSize: 12, marginTop: 2 },
    chev: { color: C.muted, fontSize: 22 },
    empty: { color: C.muted, textAlign: "center", marginTop: 80 },
  });
