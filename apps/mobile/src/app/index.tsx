import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetch } from "expo/fetch";
import { Directory, File, Paths } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import * as Notifications from "expo-notifications";
import * as Sharing from "expo-sharing";
import { useShareIntent } from "expo-share-intent";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import type { FileDownloadEvent } from "react-native-webview/lib/WebViewTypes";

import { ShareSheet } from "../ShareSheet";
import {
  filenameFromDisposition,
  loadSessionToken,
  saveSessionToken,
} from "../lib/relay";

// Relay on mobile is the server's web UI in a WebView — same screens, same
// fixes, zero duplicated client code. This file is only a shell: remember
// which server to load, keep in-app navigation inside the WebView, and hand
// everything else (auth, chat, issues, reviews) to the web app.
//
// Login persists on its own — the WebView keeps cookies + localStorage.

const STORE_KEY = "relay.serverUrl";

// Web notifications inside a WebView: Android's WebView has no Notification
// API, so inject a shim that relays `new Notification(...)` and
// requestPermission() to the native layer over postMessage. OS permission
// is asked only when the page requests it (the web app's Enable button).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const NOTIFY_BRIDGE = `
(function () {
  if (window.Notification) return;
  var pending = {};
  function N(title, opts) {
    opts = opts || {};
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: "notify", title: String(title), body: String(opts.body || "")
    }));
  }
  N.permission = window.__RN_NOTIFY_GRANTED__ ? "granted" : "default";
  N.requestPermission = function (cb) {
    var id = "p" + (N.__seq = (N.__seq || 0) + 1);
    var p = new Promise(function (res) {
      pending[id] = res;
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: "notify-permission", id: id }));
    });
    p.then(function (r) { if (cb) cb(r); });
    return p;
  };
  window.__rnNotifyResolve = function (id, result) {
    N.permission = result;
    var r = pending[id];
    delete pending[id];
    if (r) r(result);
  };
  Object.defineProperty(window, "Notification", { value: N });
})();
true;
`;

function notifyBridge(granted: boolean): string {
  return (
    "window.__RN_NOTIFY_GRANTED__ = " + (granted ? "true" : "false") + ";" +
    NOTIFY_BRIDGE
  );
}

// Every page load pushes the web session token to native so the share sheet
// and download fallback can call REST endpoints with the same auth the SPA
// uses. Empty after sign-out — stored accordingly.
const TOKEN_BRIDGE = `
try {
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: "token", token: localStorage.getItem("relay.token") || ""
  }));
} catch (e) {}
true;
`;

function toast(msg: string) {
  if (Platform.OS === "android") ToastAndroid.show(msg, ToastAndroid.SHORT);
  else Alert.alert(msg);
}

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
  const [notifyGranted, setNotifyGranted] = useState(false);
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();

  useEffect(() => {
    AsyncStorage.getItem(STORE_KEY).then((v) => {
      setServer(v ? normalizeServer(v) : null);
      setReady(true);
    });
    void Notifications.getPermissionsAsync().then((p) =>
      setNotifyGranted(p.granted),
    );
    if (Platform.OS === "android") {
      void Notifications.setNotificationChannelAsync("default", {
        name: "Messages",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
  }, []);

  const onWebMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    let m: {
      type?: string;
      title?: string;
      body?: string;
      id?: string;
      token?: string;
    };
    try {
      m = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (m.type === "token") {
      void saveSessionToken(m.token || null);
      return;
    }
    if (m.type === "notify" && m.title) {
      void Notifications.scheduleNotificationAsync({
        content: { title: m.title, body: m.body },
        trigger: null,
      });
    } else if (m.type === "notify-permission" && m.id) {
      const id = m.id;
      void Notifications.requestPermissionsAsync().then((p) => {
        setNotifyGranted(p.granted);
        web.current?.injectJavaScript(
          `window.__rnNotifyResolve(${JSON.stringify(id)},` +
            `${JSON.stringify(p.granted ? "granted" : "denied")});true;`,
        );
      });
    }
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

  // The Android WebView has no download path — the OS DownloadManager call
  // drops the auth headers/cookies Relay's attachment route needs, so the
  // transfer is done here with the bridged session token. Images and video
  // land in the gallery; everything else opens the system share/open-with
  // sheet so the file is never stranded in app storage.
  const onFileDownload = useCallback(async (e: FileDownloadEvent) => {
    const url = e.nativeEvent.downloadUrl;
    try {
      const token = await loadSessionToken();
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("http_" + res.status);
      const mime = res.headers.get("content-type") ?? "";
      const name = filenameFromDisposition(
        res.headers.get("content-disposition"),
        url.split("?")[0].split("/").pop() || "download",
      );
      const dir = new Directory(Paths.cache, "downloads");
      if (!dir.exists) dir.create();
      const file = new File(dir, name);
      if (file.exists) file.delete();
      file.write(await res.bytes());

      if (mime.startsWith("image/") || mime.startsWith("video/")) {
        const perm = await MediaLibrary.requestPermissionsAsync();
        if (perm.granted) {
          await MediaLibrary.saveToLibraryAsync(file.uri);
          toast("Saved to gallery");
          return;
        }
      }
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: mime || undefined });
      } else {
        toast("Saved to app storage");
      }
    } catch (err) {
      if (__DEV__) console.warn("download failed", err);
      toast("Download failed");
    }
  }, []);

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
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
        scalesPageToFit={false}
        sharedCookiesEnabled
        textZoom={100}
        injectedJavaScriptBeforeContentLoaded={notifyBridge(notifyGranted)}
        onMessage={onWebMessage}
        onFileDownload={onFileDownload}
        onNavigationStateChange={(nav) => setCanGoBack(nav.canGoBack)}
        onLoadStart={() => {
          webReady.current = false;
        }}
        onLoadEnd={() => {
          webReady.current = true;
          web.current?.injectJavaScript(TOKEN_BRIDGE);
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
      {hasShareIntent && (
        <ShareSheet
          server={server}
          files={shareIntent.files ?? []}
          text={shareIntent.text ?? shareIntent.webUrl}
          onDone={(projectId) => {
            resetShareIntent();
            if (projectId && webReady.current) {
              web.current?.injectJavaScript(
                `location.href=${JSON.stringify(server + "/app/p/" + projectId)};true;`,
              );
            }
          }}
        />
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
