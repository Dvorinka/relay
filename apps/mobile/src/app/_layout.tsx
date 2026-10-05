import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

// The app is a WebView shell over the server's web UI — one screen, no
// header (the web app provides its own chrome).
export default function Layout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
