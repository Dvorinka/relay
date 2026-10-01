import { createClient } from "@relay/api-client";

// Same-origin; the dev server proxies /api and /mcp to localhost:8080.
export const api = createClient("");
