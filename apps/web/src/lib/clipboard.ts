// Image copy with three fallback layers: the async clipboard API (secure
// contexts), a transcoded PNG when the source type isn't writable, then a
// selected-<img> execCommand copy — the only path WebKitGTK and insecure
// LAN origins honour. Returns whether the image itself landed; callers
// fall back to copying the link.
export async function copyImage(src: string): Promise<boolean> {
  const blob = await fetch(src)
    .then((r) => r.blob())
    .catch(() => null);
  if (blob) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      return true;
    } catch {
      // Only image/png is reliably writable — transcode everything else.
      try {
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext("2d")!.drawImage(bmp, 0, 0);
        const png = await new Promise<Blob | null>((ok) =>
          canvas.toBlob(ok, "image/png"),
        );
        if (png) {
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": png }),
          ]);
          return true;
        }
      } catch {
        /* no async clipboard — selection copy below */
      }
    }
  }
  return copySelectedImage(src);
}

// Copying a rendered <img> through the editing command puts image data on
// the clipboard in engines without navigator.clipboard.write. The element
// must have finished loading, so a temp node waits on load before the copy.
async function copySelectedImage(src: string): Promise<boolean> {
  const img = document.createElement("img");
  img.src = src;
  img.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(img);
  try {
    await new Promise((done) => {
      if (img.complete && img.naturalWidth > 0) return done(null);
      img.onload = () => done(null);
      img.onerror = () => done(null);
      setTimeout(done, 5000);
    });
    if (!img.naturalWidth) return false;
    const sel = window.getSelection();
    if (!sel) return false;
    const range = document.createRange();
    range.selectNode(img);
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand("copy");
    sel.removeAllRanges();
    return ok;
  } catch {
    return false;
  } finally {
    img.remove();
  }
}

// Clipboard write that never touches window.prompt: async clipboard API
// first, then the legacy execCommand path for insecure contexts (LAN
// origins). Returns whether the copy landed.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.cssText = "position:fixed;top:-9999px;opacity:0";
    document.body.appendChild(el);
    el.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      /* unsupported */
    }
    el.remove();
    return ok;
  }
}
