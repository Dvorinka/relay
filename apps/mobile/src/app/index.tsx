import { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { api, hydrate } from "../lib/api";
import { useTheme } from "../lib/theme";

export default function Gate() {
  const C = useTheme();
  const [state, setState] = useState<"loading" | "authed" | "anon">("loading");
  useEffect(() => {
    hydrate()
      .then(() => api.me())
      .then(() => setState("authed"))
      .catch(() => setState("anon"));
  }, []);
  if (state === "loading")
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, justifyContent: "center" }}>
        <ActivityIndicator color={C.accent} size="large" />
      </View>
    );
  return <Redirect href={state === "authed" ? "/projects" : "/login"} />;
}
