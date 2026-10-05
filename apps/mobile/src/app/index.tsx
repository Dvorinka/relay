import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

// Relay on mobile is the server's web UI in a WebView — same screens, same
// fixes, zero duplicated client code. This file is only a shell: remember
// which server to load, keep in-app navigation inside the WebView, and hand
// everything else (auth, chat, issues, reviews) to the web app.
//
// Login persists on its own — the WebView keeps cookies + localStorage.

const STORE_KEY = "relay.serverUrl";

const C = {
  bg: "#0a0a0b",
  surface: "#131416",
  border: "#232427",
  text: "#e9e9eb",
  muted: "#9c9fa7",
  accent: "#06b6d4",
};

// normalizeServer accepts "relay.example.com" or a full URL and returns the
// origin the WebView should load. Empty/invalid input gets a null.
function normalizeServer(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    return u.origin;
  } catch {
    return null;
  }
}

// relay://open/<path> and relay://open?to=<path> map onto in-app routes;
// anything unrecognised lands on the app's root which redirects sensibly.
function deepLinkPath(raw: string): string {
  const m = /^relay:\/\/(?:open\/)?(.*)$/.exec(raw.trim());
  let rest = m?.[1] ?? "";
  if (rest.startsWith("open?to=")) rest = decodeURIComponent(rest.slice(8));
  rest = rest.replace(/^\/+/, "");
  const path = "/" + rest.split("?")[0];
  const query = rest.includes("?")
    ? "?" + rest.split("?").slice(1).join("?")
    : "";
  const ok =
    path === "/app" ||
    path === "/connect" ||
    path === "/login" ||
    path.startsWith("/app/") ||
    path.startsWith("/connect/");
  return (ok ? path : "/") + query;
}

export default function Shell() {
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  const [server, setServer] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORE_KEY).then((v) => {
      setServer(v ? normalizeServer(v) : null);
      setReady(true);
    });
  }, []);

  // Hardware back walks the WebView history before exiting.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBack) {
        web.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [canGoBack]);

  // relay:// links (registered in app.json) open routes inside the web UI.
  // relay://server is the escape hatch back to the connect screen now that
  // the shell has no visible chrome. A link arriving before the WebView has
  // loaded is queued — injectJavaScript into a blank page is discarded.
  const webReady = useRef(false);
  const pendingLink = useRef<string | null>(null);
  const applyDeepLink = useCallback(
    (raw: string) => {
      if (!server) return;
      web.current?.injectJavaScript(
        `location.href=${JSON.stringify(server + deepLinkPath(raw))};true;`,
      );
    },
    [server],
  );
  const openDeepLink = useCallback(
    (raw: string | null) => {
      if (!raw) return;
      if (raw.trim().toLowerCase() === "relay://server") {
        void AsyncStorage.removeItem(STORE_KEY).then(() => {
          setServer(null);
          setFailed(false);
        });
        return;
      }
      if (!server) return;
      if (webReady.current) applyDeepLink(raw);
      else pendingLink.current = raw;
    },
    [server, applyDeepLink],
  );
  useEffect(() => {
    void Linking.getInitialURL().then(openDeepLink);
    const sub = Linking.addEventListener("url", (e) => openDeepLink(e.url));
    return () => sub.remove();
  }, [openDeepLink]);

  if (!ready) {
    return (
      <View style={[styles.fill, styles.center]}>
        <ActivityIndicator color={C.accent} size="large" />
      </View>
    );
  }

  if (!server) {
    return <ConnectScreen onConnect={(s) => setServer(s)} insets={insets} />;
  }

  const host = new URL(server).host;

  return (
    <View
      style={[
        styles.fill,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <WebView
        ref={web}
        source={{ uri: server }}
        style={styles.fill}
        domStorageEnabled
        pullToRefreshEnabled
        setSupportMultipleWindows={false}
        sharedCookiesEnabled
        onNavigationStateChange={(nav) => setCanGoBack(nav.canGoBack)}
        onLoadStart={() => {
          webReady.current = false;
        }}
        onLoadEnd={() => {
          webReady.current = true;
          const raw = pendingLink.current;
          pendingLink.current = null;
          if (raw) applyDeepLink(raw);
        }}
        onShouldStartLoadWithRequest={(req) => {
          // Same-origin stays inside; anything else goes to the real
          // browser (auth providers, downloads, external links).
          if (req.url.startsWith(server)) return true;
          if (/^https?:\/\//.test(req.url)) void Linking.openURL(req.url);
          return false;
        }}
        onError={() => setFailed(true)}
        renderLoading={() => (
          <View style={[styles.fill, styles.center, styles.overlay]}>
            <ActivityIndicator color={C.accent} size="large" />
          </View>
        )}
        startInLoadingState
      />
      {failed && (
        <View style={[styles.overlay, styles.center, styles.fill]}>
          <Text style={styles.errTitle}>Cannot reach {host}</Text>
          <Text style={styles.errText}>
            Check the URL and that the server is up.
          </Text>
          <Pressable
            style={styles.errBtn}
            onPress={() => {
              setFailed(false);
              web.current?.reload();
            }}
          >
            <Text style={styles.errBtnText}>Retry</Text>
          </Pressable>
          <Pressable
            style={styles.errBtn}
            onPress={() =>
              AsyncStorage.removeItem(STORE_KEY).then(() => {
                setServer(null);
                setFailed(false);
              })
            }
          >
            <Text style={styles.errBtnText}>Change server</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function ConnectScreen(props: {
  onConnect: (server: string) => void;
  insets: { top: number; bottom: number };
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);

  function submit() {
    const s = normalizeServer(url);
    if (!s) {
      setError(true);
      return;
    }
    void AsyncStorage.setItem(STORE_KEY, s).then(() => props.onConnect(s));
  }

  return (
    <KeyboardAvoidingView
      style={[
        styles.fill,
        { paddingTop: props.insets.top, paddingBottom: props.insets.bottom },
      ]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.connect}>
        <Image
          source={require("../../assets/icon.png")}
          style={styles.logo}
          resizeMode="contain"
        />
        <Text style={styles.title}>Welcome to Relay</Text>
        <Text style={styles.subtitle}>
          Connect to your Relay server to continue
        </Text>
        <Text style={styles.label}>Server URL</Text>
        <TextInput
          style={[styles.input, error && styles.inputError]}
          value={url}
          onChangeText={(t) => {
            setUrl(t);
            setError(false);
          }}
          placeholder="relay.example.com"
          placeholderTextColor={C.muted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        {error && (
          <Text style={styles.errText}>
            Enter a server address, e.g. relay.example.com
          </Text>
        )}
        <Pressable style={styles.connectBtn} onPress={submit}>
          <Text style={styles.connectBtnText}>Connect</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: "center", justifyContent: "center" },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: C.bg,
    padding: 24,
  },
  errTitle: { color: C.text, fontSize: 16, fontWeight: "600" },
  errText: { color: C.muted, fontSize: 13, marginTop: 6 },
  errBtn: {
    marginTop: 16,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  errBtnText: { color: C.accent, fontSize: 13 },
  connect: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 72,
  },
  logo: {
    width: 72,
    height: 72,
    alignSelf: "center",
    marginBottom: 20,
  },
  title: {
    color: C.text,
    fontSize: 24,
    fontWeight: "700",
    textAlign: "center",
  },
  subtitle: {
    color: C.muted,
    fontSize: 15,
    textAlign: "center",
    marginTop: 8,
    marginBottom: 28,
  },
  label: {
    color: C.muted,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    color: C.text,
    paddingHorizontal: 14,
    height: 48,
    fontSize: 15,
    backgroundColor: C.surface,
  },
  inputError: { borderColor: "#c0392b" },
  connectBtn: {
    marginTop: 20,
    backgroundColor: C.accent,
    borderRadius: 10,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  connectBtnText: { color: "#062a30", fontSize: 15, fontWeight: "600" },
});
