import { createSignal } from "solid-js";
import { ConfirmDialog } from "./ui";

// Imperative destructive-action confirm — one dialog host serves every call
// site, so nothing ships an unguarded delete/revoke again. Resolves true on
// confirm, false on cancel/backdrop/Escape.
type Req = {
  title: string;
  body?: string;
  confirmLabel?: string;
};

const [req, setReq] = createSignal<
  (Req & { res: (v: boolean) => void }) | null
>(null);

export function confirmDestructive(r: Req): Promise<boolean> {
  return new Promise((res) => setReq({ ...r, res }));
}

export function ConfirmHost() {
  const close = (ok: boolean) => {
    req()?.res(ok);
    setReq(null);
  };
  return (
    <ConfirmDialog
      open={req() !== null}
      onOpenChange={(o) => {
        if (!o) close(false);
      }}
      title={req()?.title ?? ""}
      body={req()?.body}
      confirmLabel={req()?.confirmLabel ?? "Delete"}
      onConfirm={() => close(true)}
    />
  );
}
