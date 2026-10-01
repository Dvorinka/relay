import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import App from "./App";
import Home from "./pages/Home";
import Inbox from "./pages/Inbox";
import Project from "./pages/Project";
import "./index.css";

render(
  () => (
    <Router root={App}>
      <Route path="/" component={Home} />
      <Route path="/inbox" component={Inbox} />
      <Route path="/p/:projectId" component={Project} />
    </Router>
  ),
  document.getElementById("root")!,
);
