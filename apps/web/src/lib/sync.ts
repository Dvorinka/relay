// Push the local-mode store onto a real Relay server. Creates each project,
// then replays its conversation messages (with replies and attachments) and
// issues in order. Server assigns fresh IDs — we keep old→new maps so reply
// links stay intact.
//
// Snapshot-imported entities (remote_ids matching this origin) already exist
// there: skip creating them, seed the id maps with themselves, and only push
// the work done locally on top — a reply in an imported thread lands under
// the real remote parent.
import { createClient } from "@relay/api-client";
import { dumpLocal, localReady, markSynced } from "./local";

export interface SyncResult {
  projects: number;
  messages: number;
  issues: number;
  todos: number;
  briefs: number;
  skipped_files: number;
}

// att.url is a live object URL for the IDB blob — fetch resolves it.
async function attachmentFile(att: {
  url: string;
  filename: string;
  content_type: string;
}): Promise<File> {
  const blob = await (await fetch(att.url)).blob();
  return new File([blob], att.filename, { type: att.content_type });
}

export async function syncToServer(
  serverUrl: string,
  email: string,
  password: string,
  onStep?: (label: string) => void,
): Promise<SyncResult> {
  const url = serverUrl.replace(/\/+$/, "");
  onStep?.("Signing in");
  const session = await createClient(url).login({ email, password });
  if (!session.token) throw new Error("server did not return a token");
  return syncWithToken(url, session.token, onStep);
}

// Browser-auth path: the code flow mints a token, no password — resolve the
// session for the workspace id, then replay the same as a password sign-in.
export async function syncWithToken(
  serverUrl: string,
  token: string,
  onStep?: (label: string) => void,
): Promise<SyncResult> {
  await localReady;
  const db = dumpLocal();
  const url = serverUrl.replace(/\/+$/, "");
  const origin = new URL(url, location.origin).origin;
  const remote = createClient(url, token);
  const ws = (await remote.session()).workspaces[0];
  if (!ws) throw new Error("account has no workspace");

  const result: SyncResult = {
    projects: 0,
    messages: 0,
    issues: 0,
    todos: 0,
    briefs: 0,
    skipped_files: 0,
  };

  // True when the entity came from THIS server's snapshot — it exists
  // remotely already. A different origin gets the full create path.
  const isRemote = (id: string | undefined | null) =>
    !!id && db.remote_ids?.[id] === origin;

  for (const p of db.projects) {
    onStep?.(`Project ${p.name}`);
    let remotePid = p.id;
    if (!isRemote(p.id)) {
      const created = await remote.createProject({
        workspace_id: ws.id,
        name: p.name,
        key: p.key,
        description: p.description,
        ...(p.icon ? { icon: p.icon } : {}),
        ...(p.color ? { color: p.color } : {}),
      });
      remotePid = created.id;
      result.projects++;
    }

    // Lanes must exist before issues that reference them. Idempotent end
    // state — safe to push even for imported projects (covers local edits).
    if (p.statuses && p.statuses.length > 0) {
      await remote.setProjectStatuses(remotePid, p.statuses);
    }
    for (const f of db.savedFilters[p.id] ?? []) {
      if (isRemote(f.id)) continue;
      await remote.createSavedFilter(remotePid, {
        name: f.name,
        filters: f.filters,
      });
    }
    for (const b of db.boards[p.id] ?? []) {
      if (isRemote(b.id)) continue;
      await remote.createBoard(remotePid, {
        name: b.name,
        filters: b.filters,
      });
    }
    // local_path deliberately stays local — it's a path on *that* machine.

    // One shared map per project: a reply can reference a message in a
    // sibling conversation (a thread's parent lives in the project conv).
    const msgIdMap = new Map<string, string>();

    // Replay one conversation's missing messages in order. Imported
    // messages skip the POST but seed the map so local replies to them
    // still thread under the real remote parent.
    const replayConv = async (
      localConvId: string,
      remoteConvId: string,
      withAttachments: boolean,
    ) => {
      const list = db.messages
        .filter((m) => m.conversation_id === localConvId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const m of list) {
        if (isRemote(m.id)) {
          msgIdMap.set(m.id, m.id);
          continue;
        }
        const attIds: string[] = [];
        if (withAttachments) {
          for (const a of m.attachments) {
            const local = db.attachments[a.id];
            if (!local || isRemote(a.id)) continue;
            try {
              const up = await remote.uploadAttachment(
                remotePid,
                await attachmentFile(local),
              );
              attIds.push(up.id);
            } catch {
              // Server rejects the file (hosted tier stores none, file
              // over cap) — the message still syncs without it.
              result.skipped_files++;
            }
          }
        }
        const posted = await remote.postMessage(
          remoteConvId,
          m.body,
          attIds.length ? attIds : undefined,
          m.parent ? msgIdMap.get(m.parent.id) : undefined,
        );
        msgIdMap.set(m.id, posted.id);
        result.messages++;
      }
    };

    const conv = db.conversations.find(
      (c) =>
        c.project_id === p.id &&
        !c.issue_id &&
        c.kind !== "thread" &&
        c.kind !== "channel",
    );
    const hasMsgs = db.messages.some((m) => m.conversation_id === conv?.id);
    // For imported projects the conv id already IS the remote one; only
    // fall back to the lookup when it was never cached.
    const remoteConvId = isRemote(p.id)
      ? (conv?.id ??
        (hasMsgs ? (await remote.projectConversation(remotePid)).id : ""))
      : (await remote.projectConversation(remotePid)).id;
    if (conv && remoteConvId) {
      onStep?.(`Messages in ${p.name}`);
      await replayConv(conv.id, remoteConvId, true);
    }

    const issueIdMap = new Map<string, string>();
    for (const i of db.issues.filter((x) => x.project_id === p.id)) {
      if (isRemote(i.id)) {
        issueIdMap.set(i.id, i.id);
        continue;
      }
      onStep?.(`Issue ${i.key}`);
      const ni = await remote.createIssue(remotePid, {
        title: i.title,
        description: i.description,
        priority: i.priority,
      });
      issueIdMap.set(i.id, ni.id);
      if (i.status !== "todo") {
        await remote.updateIssue(ni.id, { status: i.status });
      }
      result.issues++;
    }

    // Issue comment threads — each issue's own conversation. Previously
    // dropped entirely; imported issues keep their remote conversation id.
    for (const i of db.issues.filter((x) => x.project_id === p.id)) {
      const remoteIssueId = issueIdMap.get(i.id);
      const iconv = db.conversations.find((c) => c.issue_id === i.id);
      if (!remoteIssueId || !iconv) continue;
      const remoteIconv = await remote.getIssueConversation(remoteIssueId);
      await replayConv(iconv.id, remoteIconv.id, false);
    }

    // Local threads: create the remote thread off the (already mapped)
    // parent message, then replay its replies. Imported threads keep their
    // remote conversation id.
    for (const t of db.threads.filter((t) => {
      const parentConv = db.conversations.find(
        (c) => c.id === t.parent_conversation,
      );
      return parentConv?.project_id === p.id;
    })) {
      let remoteThreadConvId = t.id;
      if (!isRemote(t.id)) {
        const remoteParent = msgIdMap.get(t.parent_message_id);
        if (!remoteParent) continue; // parent never synced — skip the thread
        remoteThreadConvId = (
          await remote.createThread(
            remoteParent,
            t.title ?? undefined,
          )
        ).thread.id;
      }
      await replayConv(t.id, remoteThreadConvId, true);
    }

    // jarvis: todo→issue links don't survive sync (remote IDs differ);
    // recreate them by key if it ever matters.
    for (const t of db.todos.filter(
      (x) => (x as { project_id?: string }).project_id === p.id,
    )) {
      if (isRemote(t.id)) continue;
      await remote.createTodo(remotePid, t.content);
      if (t.done) {
        const list = await remote.listTodos(remotePid);
        const match = list.todos.find((x) => x.content === t.content);
        if (match) await remote.updateTodo(match.id, { done: true });
      }
      result.todos++;
    }

    // Briefs carry their own comment conversations — replay both. Imported
    // briefs skip the create; their conversation id is already remote.
    for (const b of db.briefs.filter((x) => x.project_id === p.id)) {
      const localConvId = b.conversation_id;
      let remoteConvId: string | undefined;
      if (isRemote(b.id)) {
        remoteConvId = localConvId ?? undefined;
      } else {
        onStep?.(`Brief ${b.title}`);
        const nb = await remote.createBrief(remotePid, {
          title: b.title,
          summary: b.summary,
          scene: b.scene,
          ...(b.issue_id && issueIdMap.has(b.issue_id)
            ? { issue_id: issueIdMap.get(b.issue_id)! }
            : {}),
        });
        result.briefs++;
        if (b.status !== "open") {
          await remote.updateBrief(nb.id, { status: b.status });
        }
        if (localConvId) {
          remoteConvId = (await remote.briefConversation(nb.id)).id;
        }
      }
      if (!localConvId || !remoteConvId) continue;
      await replayConv(localConvId, remoteConvId, false);
    }
  }

  markSynced();
  onStep?.("Done");
  return result;
}
