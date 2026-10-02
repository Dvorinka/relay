// Push the local-mode store onto a real Relay server. Creates each project,
// then replays its conversation messages (with replies and attachments) and
// issues in order. Server assigns fresh IDs — we keep old→new maps so reply
// links stay intact.
import { createClient } from "@relay/api-client";
import { dumpLocal, markSynced } from "./local";

export interface SyncResult {
  projects: number;
  messages: number;
  issues: number;
  todos: number;
}

async function dataUrlToFile(att: {
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
  const db = dumpLocal();
  const url = serverUrl.replace(/\/+$/, "");

  onStep?.("Signing in");
  const session = await createClient(url).login({ email, password });
  if (!session.token) throw new Error("server did not return a token");
  const remote = createClient(url, session.token);
  const ws = session.workspaces[0];
  if (!ws) throw new Error("account has no workspace");

  const result: SyncResult = { projects: 0, messages: 0, issues: 0, todos: 0 };

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
          await dataUrlToFile(local),
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

    for (const i of db.issues.filter((x) => x.project_id === p.id)) {
      onStep?.(`Issue ${i.key}`);
      const ni = await remote.createIssue(created.id, {
        title: i.title,
        description: i.description,
        priority: i.priority,
      });
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
  }

  markSynced();
  onStep?.("Done");
  return result;
}
