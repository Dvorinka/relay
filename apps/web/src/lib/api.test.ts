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
