import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ThemeProvider, useTheme } from "../lib/theme";

function Shell() {
  const C = useTheme();
  return (
    <>
      <StatusBar style={C.scheme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: C.surface },
          headerTintColor: C.text,
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: C.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="projects" options={{ title: "Relay" }} />
        <Stack.Screen name="inbox" options={{ title: "Inbox" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="p/[id]/index" options={{ title: "Conversation" }} />
        <Stack.Screen name="p/[id]/issues" options={{ title: "Issues" }} />
        <Stack.Screen name="p/[id]/todos" options={{ title: "Work list" }} />
        <Stack.Screen name="p/[id]/reviews" options={{ title: "Reviews" }} />
      </Stack>
    </>
  );
}

export default function Root() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}
