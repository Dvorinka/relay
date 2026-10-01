import { describe, expect, it } from "vitest";
import { deriveKey, initials, messagePreview } from "./text";

describe("initials", () => {
  it("takes the first two word letters uppercased", () => {
    expect(initials("ada lovelace")).toBe("AL");
    expect(initials("Ada Byron Lovelace")).toBe("AB");
    expect(initials("cher")).toBe("C");
    expect(initials("")).toBe("?");
  });
});

describe("deriveKey", () => {
  it("uses word initials for multi-word names", () => {
    expect(deriveKey("My Board")).toBe("MB");
    expect(deriveKey("the very long board")).toBe("TVLB");
  });

  it("uses the first letters of a single word", () => {
    expect(deriveKey("relay")).toBe("REL");
    expect(deriveKey("infrastructure")).toBe("INF");
  });

  it("keeps digits, drops punctuation, pads and clamps", () => {
    expect(deriveKey("sprint 42")).toBe("S4");
    expect(deriveKey("q")).toBe("QX");
    expect(deriveKey("a b c d e f g")).toBe("ABCDEF");
    expect(deriveKey("")).toBe("");
  });
});

describe("messagePreview", () => {
  it("strips markdown syntax and collapses whitespace", () => {
    expect(messagePreview("**bold** _it_ `code`\nnext > quote")).toBe(
      "bold it code next quote",
    );
    expect(messagePreview("[label](https://x) ![img](y)")).toBe("label");
  });
});
