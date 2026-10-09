import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheGet, cachePut, clearApiCache } from "./cache";
import {
  markUp,
  probeNow,
  resilientFetch,
  serverState,
} from "./offline";

// Node has no IndexedDB — the cache exercises its in-memory fallback here.
describe("resilientFetch", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearApiCache();
    markUp("http://x.test");
    markUp("http://y.test");
    markUp("http://z.test");
    markUp("http://w.test");
  });

  it("serves the cached GET body when the server is unreachable", async () => {
    await cachePut("|http://x.test/api/conv", `{"messages":[1]}`);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    const res = await resilientFetch("http://x.test/api/conv");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [1] });
    expect(serverState("http://x.test")).toBe("down");
  });

  it("serves the cached GET body on a 5xx response", async () => {
    await cachePut("|http://z.test/api/b", `{"stale":true}`);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("err", { status: 503 })),
    );
    const res = await resilientFetch("http://z.test/api/b");
    expect(await res.json()).toEqual({ stale: true });
    expect(serverState("http://z.test")).toBe("down");
  });

  it("caches successful GET bodies and marks the server up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(`{"ok":1}`, { status: 200 })),
    );
    await resilientFetch("http://y.test/api/a");
    expect(await cacheGet("|http://y.test/api/a")).toBe(`{"ok":1}`);
    expect(serverState("http://y.test")).toBe("up");
  });

  it("never caches or serves non-GET requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );
    await resilientFetch("http://w.test/api/x", { method: "POST" });
    expect(await cacheGet("|http://w.test/api/x")).toBeUndefined();
  });

  it("passes failures through when nothing is cached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("err", { status: 503 })),
    );
    const res = await resilientFetch("http://w.test/api/miss");
    expect(res.status).toBe(503);
  });

  it("keeps cached bodies separate per auth token", async () => {
    await cachePut("Bearer t1|http://x.test/api/me", `{"u":1}`);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    const res = await resilientFetch("http://x.test/api/me", {
      headers: { Authorization: "Bearer t1" },
    });
    expect(await res.json()).toEqual({ u: 1 });
    // Same URL, different principal → no cross-user stale data.
    const other = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", other);
    await expect(
      resilientFetch("http://x.test/api/me", {
        headers: { Authorization: "Bearer t2" },
      }),
    ).rejects.toThrow("fetch failed");
  });
});

describe("probeNow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("marks the server up when health answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );
    expect(await probeNow("http://probe.test")).toBe(true);
    expect(serverState("http://probe.test")).toBe("up");
  });

  it("returns false when health fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("down")),
    );
    expect(await probeNow("http://dead.test")).toBe(false);
  });
});
