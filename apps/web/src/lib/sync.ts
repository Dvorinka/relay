// Push the local-mode store onto a real Relay server. Creates each project,
// then replays its conversation messages (with replies and attachments) and
// issues in order. Server assigns fresh IDs — we keep old→new maps so reply
// links stay intact.
import { createClient } from "@relay/api-client";
import { dumpLocal, localReady, markSynced } from "./local";

export interface SyncResult {
  projects: number;
  messages: number;
  issues: number;
  todos: number;
  briefs: number;
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
  const remote = createClient(url, token);
  const ws = (await remote.session()).workspaces[0];
  if (!ws) throw new Error("account has no workspace");

  const result: SyncResult = {
    projects: 0,
    messages: 0,
    issues: 0,
    todos: 0,
    briefs: 0,
  };

  for (const p of db.projects) {
    onStep?.(`Project ${p.name}`);
    const created = await remote.createProject({
      workspace_id: ws.id,
      name: p.name,
      key: p.key,
      description: p.description,
      ...(p.icon ? { icon: p.icon } : {}),
      ...(p.color ? { color: p.color } : {}),
    });
    result.projects++;

    // Lanes must exist before issues that reference them.
    if (p.statuses && p.statuses.length > 0) {
      await remote.setProjectStatuses(created.id, p.statuses);
    }
    for (const f of db.savedFilters[p.id] ?? []) {
      await remote.createSavedFilter(created.id, {
        name: f.name,
        filters: f.filters,
      });
    }
    for (const b of db.boards[p.id] ?? []) {
      await remote.createBoard(created.id, {
        name: b.name,
        filters: b.filters,
      });
    }
    // local_path deliberately stays local — it's a path on *that* machine.

    // Attachments first so message posts can reference the new IDs.
    const conv = db.conversations.find(
      (c) => c.project_id === p.id && !c.issue_id,
    );
    const msgs = db.messages
      .filter((m) => m.conversation_id === conv?.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    const remoteConv = await remote.projectConversation(created.id);
    const msgIdMap = new Map<string, string>();
    for (const m of msgs) {
      onStep?.(`Message in ${p.name}`);
      const attIds: string[] = [];
      for (const a of m.attachments) {
        const local = db.attachments[a.id];
        if (!local) continue;
        const up = await remote.uploadAttachment(
          created.id,
          await attachmentFile(local),
        );
        attIds.push(up.id);
      }
      const posted = await remote.postMessage(
        remoteConv.id,
        m.body,
        attIds.length ? attIds : undefined,
        m.parent ? msgIdMap.get(m.parent.id) : undefined,
      );
      msgIdMap.set(m.id, posted.id);
      result.messages++;
    }

    const issueIdMap = new Map<string, string>();
    for (const i of db.issues.filter((x) => x.project_id === p.id)) {
      onStep?.(`Issue ${i.key}`);
      const ni = await remote.createIssue(created.id, {
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

    // jarvis: todo→issue links don't survive sync (remote IDs differ);
    // recreate them by key if it ever matters.
    for (const t of db.todos.filter(
      (x) => (x as { project_id?: string }).project_id === p.id,
    )) {
      await remote.createTodo(created.id, t.content);
      if (t.done) {
        const list = await remote.listTodos(created.id);
        const match = list.todos.find((x) => x.content === t.content);
        if (match) await remote.updateTodo(match.id, { done: true });
      }
      result.todos++;
    }

    // Briefs carry their own comment conversations — replay both.
    for (const b of db.briefs.filter((x) => x.project_id === p.id)) {
      onStep?.(`Brief ${b.title}`);
      const nb = await remote.createBrief(created.id, {
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
      const localConvId = b.conversation_id;
      if (!localConvId) continue;
      const remoteConv = await remote.briefConversation(nb.id);
      const bMsgs = db.messages
        .filter((m) => m.conversation_id === localConvId)
        .sort((a, c) => a.created_at.localeCompare(c.created_at));
      const bMsgIdMap = new Map<string, string>();
      for (const m of bMsgs) {
        const posted = await remote.postMessage(
          remoteConv.id,
          m.body,
          undefined,
          m.parent ? bMsgIdMap.get(m.parent.id) : undefined,
        );
        bMsgIdMap.set(m.id, posted.id);
        result.messages++;
      }
    }
  }

  markSynced();
  onStep?.("Done");
  return result;
}
