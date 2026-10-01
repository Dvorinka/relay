/** Up-to-two-letter initials for avatar fallbacks. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "?";
}

/**
 * Derives a project key from a name: word initials ("My Board" -> "MB"),
 * or the first three letters of a single word ("relay" -> "REL").
 * Output matches the server's /^[A-Z0-9]{2,6}$/ rule when the name has
 * at least two usable characters; the field stays editable either way.
 */
export function deriveKey(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  let key =
    words.length > 1
      ? words.map((w) => w[0]).join("")
      : (words[0] ?? "").slice(0, 3);
  if (key.length < 2) {
    key = key.padEnd(2, "X");
  }
  return key.slice(0, 6);
}

/** Strips markdown syntax for one-line previews. */
export function messagePreview(body: string): string {
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
