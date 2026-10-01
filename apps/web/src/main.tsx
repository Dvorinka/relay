import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import App from "./App";
import ForgotPassword from "./features/auth/ForgotPassword";
import Login from "./features/auth/Login";
import Register from "./features/auth/Register";
import ResetPassword from "./features/auth/ResetPassword";
import Settings from "./features/workspaces/Settings";
import "./index.css";
import Home from "./pages/Home";
import Inbox from "./pages/Inbox";
import Project from "./pages/Project";
import { SessionProvider } from "./stores/session";

render(
  () => (
    <SessionProvider>
      <Router>
        <Route path="/login" component={Login} />
        <Route path="/register" component={Register} />
        <Route path="/forgot" component={ForgotPassword} />
        <Route path="/reset" component={ResetPassword} />
        <Route path="/" component={App}>
          <Route path="/" component={Home} />
          <Route path="/inbox" component={Inbox} />
          <Route path="/p/:projectId" component={Project} />
          <Route path="/settings" component={Settings} />
        </Route>
      </Router>
    </SessionProvider>
  ),
  document.getElementById("root")!,
);
