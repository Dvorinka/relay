import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, createClient } from "@relay/api-client";

describe("createClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the parsed health response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status: "ok", version: "0.0.0" }),
            { status: 200 },
          ),
      ),
    );
    const client = createClient("http://localhost:8080");
    await expect(client.health()).resolves.toEqual({
      status: "ok",
      version: "0.0.0",
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8080/api/health",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("uploads an attachment as multipart without a manual Content-Type", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "a1",
            project_id: "p1",
            filename: "hi.txt",
            content_type: "text/plain",
            size_bytes: 2,
            created_at: "2026-01-01T00:00:00Z",
          }),
          { status: 201 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("");
    const file = new File(["hi"], "hi.txt", { type: "text/plain" });
    const attachment = await client.uploadAttachment("p1", file);
    expect(attachment.id).toBe("a1");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/projects/p1/attachments");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
    if (init?.body instanceof FormData) {
      expect(init.body.get("file")).toBeInstanceOf(File);
    }
  });

  it("builds the attachment download URL", () => {
    const client = createClient("http://localhost:8080");
    expect(client.attachmentURL("p1", "a1")).toBe(
      "http://localhost:8080/api/projects/p1/attachments/a1/url",
    );
  });

  it("posts attachment_ids with the message body", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "m1",
            conversation_id: "c1",
            author: { kind: "user", id: "u1", name: "U" },
            body: "hi",
            attachments: [],
            created_at: "2026-01-01T00:00:00Z",
          }),
          { status: 201 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createClient("");
    await client.postMessage("c1", "hi", ["a1", "a2"]);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      body: "hi",
      attachment_ids: ["a1", "a2"],
    });
  });

  it("throws ApiClientError with the spec error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "unauthorized", message: "no session" },
            }),
            { status: 401 },
          ),
      ),
    );
    const client = createClient("");
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).status).toBe(401);
    expect((err as ApiClientError).message).toBe("no session");
  });
});
