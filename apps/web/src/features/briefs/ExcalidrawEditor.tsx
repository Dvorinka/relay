import type { Brief } from "@relay/api-client";
import { api } from "../../lib/api";
import { SceneEditor } from "./SceneEditor";

// ExcalidrawEditor keeps the brief-specific save path; the canvas shell
// itself is SceneEditor, shared with the ideas page.
export function ExcalidrawEditor(props: {
  brief: Brief;
  onSaved: (b: Brief) => void;
  onClose: () => void;
}) {
  return (
    <SceneEditor
      title={props.brief.title}
      saveLabel="Save to brief"
      scene={props.brief.scene}
      onSave={async (scene) => {
        const updated = await api.updateBrief(props.brief.id, { scene });
        props.onSaved(updated);
      }}
      onClose={props.onClose}
    />
  );
}
