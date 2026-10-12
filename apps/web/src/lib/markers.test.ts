import { describe, expect, it } from "vitest";
import { attachmentMarker, stripMarkerText } from "./markers";

const img = (name = "shot.png") => new File(["x"], name, { type: "image/png" });
const txt = (name = "notes.txt") => new File(["x"], name, { type: "text/plain" });

describe("attachmentMarker", () => {
  it("numbers images", () => {
    expect(attachmentMarker(img(), 3)).toBe("[image 3]");
  });
  it("uses the filename for other files", () => {
    expect(attachmentMarker(txt("a.txt"), 1)).toBe("[a.txt]");
  });
  it("strips brackets from filenames so markers stay parseable", () => {
    expect(attachmentMarker(txt("a[1].txt"), 1)).toBe("[a1.txt]");
  });
});

describe("stripMarkerText", () => {
  it("removes a mid-draft marker without a double gap", () => {
    expect(stripMarkerText("see [a.txt] here", "[a.txt]")).toBe("see here");
  });
  it("removes a leading marker", () => {
    expect(stripMarkerText("[a.txt] see", "[a.txt]")).toBe("see");
  });
  it("removes a trailing marker plus its pad space", () => {
    expect(stripMarkerText("see [a.txt] ", "[a.txt]")).toBe("see ");
  });
  it("leaves text without the marker untouched", () => {
    expect(stripMarkerText("see here", "[a.txt]")).toBe("see here");
  });
  it("removes only the first occurrence", () => {
    expect(stripMarkerText("[a.txt] and [a.txt]", "[a.txt]")).toBe(
      "and [a.txt]",
    );
  });
  it("handles image markers", () => {
    expect(stripMarkerText("look [image 2] ok", "[image 2]")).toBe("look ok");
  });
});
