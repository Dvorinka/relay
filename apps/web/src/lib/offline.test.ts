import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheGet, cachePut, clearApiCache } from "./cache";
import {
  clearOutbox,
  isQueuedError,
  markUp,
  onServerUp,
  outboxPending,
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

describe("mutation outbox", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearOutbox();
    markUp("http://q.test");
    markUp("http://r.test");
  });

  it("queues mutations while down and replays them on recovery", async () => {
    // The failure that marks the origin down is NOT queued — it may have
    // landed server-side already.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(
      resilientFetch("http://q.test/api/conv/1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `{"body":"hi"}`,
      }),
    ).rejects.toThrow("fetch failed");
    expect(serverState("http://q.test")).toBe("down");
    expect(outboxPending()).toBe(0);

    // While down, mutations queue and never touch the wire.
    const dead = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", dead);
    const err = await resilientFetch("http://q.test/api/conv/1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"body":"again"}`,
    }).catch((e) => e);
    expect(isQueuedError(err)).toBe(true);
    expect(dead).not.toHaveBeenCalled();
    expect(outboxPending()).toBe(1);

    // Recovery drains the queue before listeners fire.
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
        sent.push(`${u} ${String(i?.body)}`);
        return new Response("{}", { status: 200 });
      }),
    );
    let fired = false;
    const off = onServerUp(() => {
      fired = true;
    });
    markUp("http://q.test");
    await vi.waitFor(() => expect(fired).toBe(true));
    expect(sent).toEqual([
      `http://q.test/api/conv/1/messages {"body":"again"}`,
    ]);
    expect(outboxPending()).toBe(0);
    off();
  });

  it("does not queue FormData bodies or auth calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(
      resilientFetch("http://r.test/api/x", { method: "POST" }),
    ).rejects.toThrow();
    const dead = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", dead);

    const form = new FormData();
    form.set("file", new Blob(["x"]));
    await expect(
      resilientFetch("http://r.test/api/upload", { method: "PUT", body: form }),
    ).rejects.toThrow("fetch failed");
    await expect(
      resilientFetch("http://r.test/api/auth/login", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow("fetch failed");
    expect(dead).toHaveBeenCalledTimes(2);
    expect(outboxPending()).toBe(0);
  });

  it("keeps the queue when the server is still down at replay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(
      resilientFetch("http://q.test/api/x", { method: "POST" }),
    ).rejects.toThrow();
    await expect(
      resilientFetch("http://q.test/api/x", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow(/queued/i);
    expect(outboxPending()).toBe(1);

    // markUp replays; the replay itself fails → entry stays queued.
    let fired = false;
    const off = onServerUp(() => {
      fired = true;
    });
    markUp("http://q.test");
    await vi.waitFor(() => expect(fired).toBe(true));
    expect(outboxPending()).toBe(1);
    off();
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
