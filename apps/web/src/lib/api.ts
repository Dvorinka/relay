import {
  ApiClientError,
  createClient,
} from "@relay/api-client";
import { local } from "./local";
import { net } from "./net";

type Client = ReturnType<typeof createClient>;

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
    return (net.client() as unknown as Record<string, unknown>)[prop];
  },
});
