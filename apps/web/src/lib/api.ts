import {
  ApiClientError,
  createClient,
  type Attachment,
} from "@relay/api-client";
import { bridgeUpload, hasUploadBridge } from "./desktop";
import { local } from "./local";
import { activeDown, net } from "./net";
import { enqueueUpload, markDown } from "./offline";

type Client = ReturnType<typeof createClient>;

// Upload methods whose bodies the desktop webview can drop — when the Wails
// bridge exists these cross window.go.main.App.ProxyRequest as base64 JSON
// instead of fetch. Each entry maps the call args to the request path.
// uploadAttachment is not here: the proxy intercepts it above so uploads
// can park in the outbox while the server is down.
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
  uploadImageURL: (a) => ({
    method: "PUT",
    path: a[0] as string,
    url: a[1] as string,
  }),
};

// A transport-level failure (fetch threw, or the desktop bridge got a 5xx /
// nothing back) means the upload never landed — safe to park. Real 4xx
// answers (too large, forbidden) still surface to the caller.
function uploadTransportFail(err: unknown): boolean {
  return (
    !(err instanceof ApiClientError) || err.status === 0 || err.status >= 500
  );
}

// Parking an upload hands back a placeholder attachment ("att:…") shaped
// like the real thing. The message composer references it like any uploaded
// id; drainOutbox replays the file and rewrites the reference on recovery.
async function queueAttachmentUpload(
  projectId: string,
  file: File,
): Promise<Attachment> {
  const base = net.serverUrl();
  const headers: Record<string, string> = {};
  if (net.token()) headers["Authorization"] = `Bearer ${net.token()}`;
  const id = await enqueueUpload(
    `${base}/api/projects/${projectId}/attachments`,
    file,
    file.name,
    { headers },
  );
  if (!id) throw new ApiClientError(0, "offline queue is full");
  return {
    id,
    project_id: projectId,
    filename: file.name,
    content_type: file.type || "application/octet-stream",
    size_bytes: file.size,
    created_at: new Date().toISOString(),
  };
}

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
    // Attachments are the one upload the outbox can park — a queued
    // placeholder id lets the message itself queue behind it.
    if (prop === "uploadAttachment") {
      return async (projectId: string, file: File): Promise<Attachment> => {
        if (activeDown()) return queueAttachmentUpload(projectId, file);
        try {
          if (hasUploadBridge()) {
            // SAFETY: the bridge returns the endpoint's parsed JSON body.
            return (await bridgeUpload(
              "POST",
              `/api/projects/${projectId}/attachments`,
              net.token() ?? "",
              file,
            )) as Attachment;
          }
          return await net.client().uploadAttachment(projectId, file);
        } catch (err) {
          if (uploadTransportFail(err)) {
            markDown(net.serverUrl() || location.origin);
            return queueAttachmentUpload(projectId, file);
          }
          throw err;
        }
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
