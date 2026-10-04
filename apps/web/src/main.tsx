import { Navigate, Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import App from "./App";
import { desktopOpen } from "./lib/desktop";
import ForgotPassword from "./features/auth/ForgotPassword";
import Login from "./features/auth/Login";
import Register from "./features/auth/Register";
import ResetPassword from "./features/auth/ResetPassword";
import Settings from "./features/workspaces/Settings";
import IssueKeyRedirect from "./features/issues/IssueKeyRedirect";
import IssuePage from "./features/issues/IssuePage";
import BoardPage from "./features/issues/BoardPage";
import ProjectPage from "./features/projects/ProjectPage";
import "./index.css";
import Home from "./pages/Home";
import Inbox from "./pages/Inbox";
import { SessionProvider } from "./stores/session";

// Push notifications ride this worker; harmless when the server has no
// VAPID keys (the subscribe call then reports disabled).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// External links can't work inside the desktop webview — no github.com
// session, no file downloads — so off-origin clicks go through the Wails
// /~desktop-open bridge to the user's real browser. In a normal browser the
// bridge answers false and we fall back to an ordinary new tab, matching
// what target="_blank" would have done.
document.addEventListener(
  "click",
  (e) => {
    const a = (e.target as HTMLElement).closest?.("a[href]");
    if (!a) return;
    const url = new URL((a as HTMLAnchorElement).href, location.href);
    if (url.origin === location.origin) return;
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    e.preventDefault();
    void desktopOpen(url.href).then((ok) => {
      if (!ok) window.open(url.href, "_blank", "noopener");
    });
  },
  true,
);

render(
  () => (
    <SessionProvider>
      <Router>
        <Route path="/login" component={Login} />
        <Route path="/register" component={Register} />
        <Route path="/forgot" component={ForgotPassword} />
        <Route path="/reset" component={ResetPassword} />
        <Route path="/" component={() => <Navigate href="/app" />} />
        <Route path="/app" component={App}>
          <Route path="/" component={Home} />
          <Route path="/inbox" component={Inbox} />
          <Route path="/p/:projectId" component={ProjectPage} />
          <Route path="/p/:projectId/board" component={BoardPage} />
          <Route path="/p/:projectId/i/:issueId" component={IssuePage} />
          <Route path="/p/:projectId/k/:key" component={IssueKeyRedirect} />
          <Route path="/settings" component={Settings} />
        </Route>
      </Router>
    </SessionProvider>
  ),
  document.getElementById("root")!,
);
