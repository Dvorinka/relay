import { Redirect } from "expo-router";

// Incoming relay:// deep links don't match any route (the app has just "/"),
// so expo-router lands here. Linking.getInitialURL still holds the original
// relay:// URL — the shell reads it and injects the mapped web path, so a
// plain redirect is all that's needed.
export default function NotFound() {
  return <Redirect href="/" />;
}
