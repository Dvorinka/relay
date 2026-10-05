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
