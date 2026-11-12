import { describe, expect, it } from "vitest";
import { horizontalSwipe } from "./swipe";

describe("horizontalSwipe", () => {
  it("ignores vertical scrolls", () => {
    expect(horizontalSwipe(20, 80)).toBeNull();
    expect(horizontalSwipe(-40, 40)).toBeNull();
  });

  it("requires the threshold", () => {
    expect(horizontalSwipe(55, 0)).toBeNull();
    expect(horizontalSwipe(56, 10)).toBe("right");
    expect(horizontalSwipe(-56, 4)).toBe("left");
  });
});
