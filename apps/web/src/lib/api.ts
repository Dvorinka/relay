import {
  ApiClientError,
  createClient,
} from "@relay/api-client";
import { bridgeUpload, hasUploadBridge } from "./desktop";
import { local } from "./local";
import { net } from "./net";

type Client = ReturnType<typeof createClient>;

// Upload methods whose bodies the desktop webview can drop — when the Wails
// bridge exists these cross window.go.main.App.ProxyRequest as base64 JSON
// instead of fetch. Each entry maps the call args to the request path.
const UPLOAD_ROUTES: Record<
  string,
  (args: unknown[]) => { method: string; path: string; file?: File; url?: string }
> = {
  uploadAvatar: (a) => ({
    method: "PUT",
    path: "/api/me/avatar",
    file: a[0] as File,
  }),
  uploadAgentAvatar: (a) => ({
    method: "PUT",
    path: `/api/agents/${a[0]}/avatar`,
    file: a[1] as File,
  }),
  uploadProjectIcon: (a) => ({
    method: "PUT",
    path: `/api/projects/${a[0]}/icon`,
    file: a[1] as File,
  }),
  uploadWorkspaceIcon: (a) => ({
    method: "PUT",
    path: `/api/workspaces/${a[0]}/icon`,
    file: a[1] as File,
  }),
  uploadAttachment: (a) => ({
    method: "POST",
    path: `/api/projects/${a[0]}/attachments`,
    file: a[1] as File,
  }),
  uploadImageURL: (a) => ({
    method: "PUT",
    path: a[0] as string,
    url: a[1] as string,
  }),
};

// One `api` object for the whole app. In local mode calls land on the
// localStorage adapter; otherwise they go to the configured server (or
// same-origin). Unimplemented-in-local methods fail with a clear error
// instead of silently hitting a network that may not exist.
export const api = new Proxy({} as Client, {
  get(_, prop: string) {
    if (net.isLocal()) {
      const impl = (local as Record<string, unknown>)[prop];
      if (impl !== undefined) return impl;
      return () => {
        throw new ApiClientError(
          0,
          `"${prop}" needs a server — not available on this device`,
        );
      };
    }
    const route = UPLOAD_ROUTES[prop];
    if (route && hasUploadBridge()) {
      return async (...args: unknown[]) => {
        const { method, path, file, url } = route(args);
        return bridgeUpload(method, path, net.token() ?? "", file, url);
      };
    }
    return (net.client() as unknown as Record<string, unknown>)[prop];
  },
});
