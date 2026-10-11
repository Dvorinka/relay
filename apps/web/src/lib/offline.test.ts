import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheGet, cachePut, clearApiCache } from "./cache";
import {
  clearOutbox,
  enqueueUpload,
  isQueuedError,
  markUp,
  onServerUp,
  outboxPending,
  probeNow,
  queuedMessages,
  removeOutboxEntry,
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

  it("queues the marking request when replay is provably safe", async () => {
    // A transport failure carrying client_msg_id queues like any parked
    // mutation — the server dedupes the replay if the first send landed.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    const err = await resilientFetch("http://q.test/api/conv/1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"body":"hi","client_msg_id":"cm-1"}`,
    }).catch((e) => e);
    expect(isQueuedError(err)).toBe(true);
    expect(serverState("http://q.test")).toBe("down");
    expect(outboxPending()).toBe(1);

    // PUT/DELETE are idempotent by method — the marking failure queues too.
    await resilientFetch("http://q.test/api/msg/2/reactions", {
      method: "PUT",
      body: `{"emoji":"✅"}`,
    }).catch(() => {});
    expect(outboxPending()).toBe(2);

    // Recovery replays both in order.
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
        sent.push(`${i?.method} ${u}`);
        return new Response("{}", { status: 200 });
      }),
    );
    markUp("http://q.test");
    await vi.waitFor(() => expect(outboxPending()).toBe(0));
    expect(sent).toEqual([
      "POST http://q.test/api/conv/1/messages",
      "PUT http://q.test/api/msg/2/reactions",
    ]);
  });

  it("still drops a marking POST without an idempotency key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(
      resilientFetch("http://r.test/api/conv/1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: `{"body":"no key"}`,
      }),
    ).rejects.toThrow("fetch failed");
    expect(outboxPending()).toBe(0);
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

  it("queues PATCH edits like PUT/DELETE — same end state on replay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    const err = await resilientFetch("http://q.test/api/messages/9", {
      method: "PATCH",
      body: `{"body":"edited"}`,
    }).catch((e) => e);
    expect(isQueuedError(err)).toBe(true);
    expect(outboxPending()).toBe(1);
  });

  it("drops ephemeral typing/read writes instead of parking them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(
      resilientFetch("http://q.test/api/x", { method: "POST" }),
    ).rejects.toThrow();
    for (const path of ["typing", "read"]) {
      const err = await resilientFetch(
        `http://q.test/api/conversations/1/${path}`,
        { method: "POST" },
      ).catch((e) => e);
      expect(isQueuedError(err)).toBe(true);
    }
    expect(outboxPending()).toBe(0);
  });

  it("replays a parked upload as JSON and rewrites its placeholder in later bodies", async () => {
    // Server dies; an upload and the message referencing it both park.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(
      resilientFetch("http://q.test/api/x", { method: "POST" }),
    ).rejects.toThrow();
    const placeholder = await enqueueUpload(
      "http://q.test/api/projects/p1/attachments",
      new Blob(["img-bytes"], { type: "image/png" }),
      "pic.png",
      { headers: { Authorization: "Bearer t" } },
    );
    expect(placeholder).toMatch(/^att:/);
    await resilientFetch("http://q.test/api/conversations/c1/messages", {
      method: "POST",
      body: JSON.stringify({
        body: "with pic",
        attachment_ids: [placeholder],
      }),
    }).catch(() => {});
    expect(outboxPending()).toBe(2);

    // Recovery: the upload lands first as {name,data} JSON, then the
    // message body carries the real attachment id — not the placeholder.
    const sent: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
        sent.push({ url: String(u), body: i?.body as string | undefined });
        if (sent.length === 1) {
          return new Response(`{"id":"real-att-7"}`, { status: 201 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    markUp("http://q.test");
    await vi.waitFor(() => expect(outboxPending()).toBe(0));
    expect(sent).toHaveLength(2);
    const up = JSON.parse(sent[0]!.body!) as { name: string; data: string };
    expect(sent[0]!.url).toBe("http://q.test/api/projects/p1/attachments");
    expect(up.name).toBe("pic.png");
    expect(atob(up.data)).toBe("img-bytes");
    expect(sent[1]!.body).toContain('"real-att-7"');
    expect(sent[1]!.body).not.toContain(placeholder!);
  });

  it("queuedMessages surfaces parked sends for one conversation only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(
      resilientFetch("http://q.test/api/x", { method: "POST" }),
    ).rejects.toThrow();
    await resilientFetch("http://q.test/api/conversations/c1/messages", {
      method: "POST",
      body: `{"body":"first","attachment_ids":["a"]}`,
    }).catch(() => {});
    await resilientFetch("http://q.test/api/conversations/c2/messages", {
      method: "POST",
      body: `{"body":"other convo"}`,
    }).catch(() => {});
    const list = queuedMessages("c1");
    expect(list).toHaveLength(1);
    expect(list[0]!.body).toBe("first");
    expect(list[0]!.attachmentIds).toEqual(["a"]);

    // Discarding removes just that entry.
    await removeOutboxEntry(list[0]!.entryId);
    expect(queuedMessages("c1")).toHaveLength(0);
    expect(queuedMessages("c2")).toHaveLength(1);
  });

  it("sends a late request on the resolved id once its upload drained", async () => {
    // Outage: upload parks. Server returns; the drain resolves att→real.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    await expect(
      resilientFetch("http://q.test/api/x", { method: "POST" }),
    ).rejects.toThrow();
    const placeholder = await enqueueUpload(
      "http://q.test/api/projects/p1/attachments",
      new Blob(["b"], { type: "image/png" }),
      "p.png",
    );
    const sent: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
        sent.push({ url: String(u), body: i?.body as string | undefined });
        return new Response(`{"id":"real-9"}`, { status: 201 });
      }),
    );
    markUp("http://q.test");
    await vi.waitFor(() => expect(outboxPending()).toBe(0));

    // Now a message references the same placeholder — it must go to the
    // wire carrying the REAL id, not queue behind a drain that already ran.
    sent.length = 0;
    const res = await resilientFetch(
      "http://q.test/api/conversations/c1/messages",
      {
        method: "POST",
        body: JSON.stringify({
          body: "late",
          attachment_ids: [placeholder],
        }),
      },
    );
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('"real-9"');
    expect(sent[0]!.body).not.toContain(placeholder!);
  });

  it("queues a send behind a still-parked upload and drains both in order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );
    markUp("http://q.test");
    // The upload entry is parked but no drain is running yet.
    const placeholder = await enqueueUpload(
      "http://q.test/api/projects/p1/attachments",
      new Blob(["b"], { type: "image/png" }),
      "p.png",
    );
    const sent: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
        sent.push({ url: String(u), body: i?.body as string | undefined });
        return new Response(`{"id":"real-2"}`, { status: 201 });
      }),
    );
    const err = await resilientFetch(
      "http://q.test/api/conversations/c1/messages",
      {
        method: "POST",
        body: JSON.stringify({
          body: "waits for upload",
          attachment_ids: [placeholder],
        }),
      },
    ).catch((e) => e);
    // The send parks; the drain the send triggered replays upload→message.
    expect(isQueuedError(err)).toBe(true);
    await vi.waitFor(() => expect(outboxPending()).toBe(0));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.url).toContain("/attachments");
    expect(sent[1]!.body).toContain('"real-2"');
  });

  it("strips a placeholder that can never resolve and still sends", async () => {
    const sent: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: RequestInfo | URL, i?: RequestInit) => {
        sent.push({ url: String(u), body: i?.body as string | undefined });
        return new Response("{}", { status: 201 });
      }),
    );
    markUp("http://q.test");
    // No parked upload for att:gone — its entry was discarded.
    const res = await resilientFetch(
      "http://q.test/api/conversations/c1/messages",
      {
        method: "POST",
        body: JSON.stringify({
          body: "no attachment",
          attachment_ids: ["att:gone-1"],
        }),
      },
    );
    expect(res.status).toBe(201);
    expect(outboxPending()).toBe(0);
    const body = JSON.parse(sent[0]!.body!) as { attachment_ids: string[] };
    expect(body.attachment_ids).toEqual([]);
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
