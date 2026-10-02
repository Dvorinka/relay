import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { C } from "../lib/theme";

export default function Root() {
  return (
    <>
      <StatusBar style="light" />
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
        <Stack.Screen name="p/[id]/index" options={{ title: "Conversation" }} />
        <Stack.Screen name="p/[id]/issues" options={{ title: "Issues" }} />
        <Stack.Screen name="p/[id]/todos" options={{ title: "Work list" }} />
      </Stack>
    </>
  );
}
