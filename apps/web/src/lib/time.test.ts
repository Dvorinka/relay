import { afterEach, describe, expect, it, vi } from "vitest";
import { timeAgo } from "./time";

describe("timeAgo", () => {
  afterEach(() => vi.useRealTimers());

  it("formats relative times then falls back to a date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T12:00:00Z"));
    const at = (s: string) => new Date(s).toISOString();

    expect(timeAgo(at("2026-03-04T11:59:30Z"))).toBe("just now");
    expect(timeAgo(at("2026-03-04T11:58:00Z"))).toBe("2m ago");
    expect(timeAgo(at("2026-03-04T09:00:00Z"))).toBe("3h ago");
    expect(timeAgo(at("2026-03-02T12:00:00Z"))).toBe("2d ago");
    expect(timeAgo(at("2026-02-20T12:00:00Z"))).toBe("Feb 20");
    expect(timeAgo(at("2025-06-01T12:00:00Z"))).toBe("Jun 1, 2025");
  });

  it("returns empty string for unparseable input", () => {
    expect(timeAgo("not-a-date")).toBe("");
  });
});
