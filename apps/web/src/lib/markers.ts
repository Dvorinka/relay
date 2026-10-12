// Attachment draft markers: [image N] / [filename] tokens anchor each staged
// attachment in the message draft. When an upload fails or its chip is
// removed the marker must go with it, or the draft keeps a dead token that
// reads like a real reference (and can even send as one).

/** Marker text for a staged file, given the current image ordinal. */
export function attachmentMarker(file: File, imageOrdinal: number): string {
  return file.type.startsWith("image/")
    ? `[image ${imageOrdinal}]`
    : `[${file.name.replaceAll("[", "").replaceAll("]", "")}]`;
}

/**
 * Remove one auto-inserted marker plus a single adjacent space, so removal
 * leaves neither a dead token nor a double gap. First occurrence wins —
 * markers are distinctive enough that a user-typed collision is unlikely,
 * and the stored marker is always the exact inserted text.
 */
export function stripMarkerText(cur: string, marker: string): string {
  if (!marker) return cur;
  const i = cur.indexOf(marker);
  if (i === -1) return cur;
  const next = cur.slice(0, i) + cur.slice(i + marker.length);
  if (next[i] === " " && (i === 0 || next[i - 1] === " ")) {
    return next.slice(0, i) + next.slice(i + 1);
  }
  return next;
}
