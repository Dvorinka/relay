// Offline outbox: messages composed while the server is unreachable are
// persisted (attachments staged into app storage) and replayed on the next
// successful fetch. Deliberately a queue, not a local database — the phone
// stays server-first; the desktop web app owns the full offline mode.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import { api } from "./api";

export interface QueuedFile {
  uri: string; // staged copy inside the app's document directory
  name: string;
  type: string;
}

export interface QueuedMessage {
  id: string;
  projectId: string;
  conversationId: string;
  body: string;
  replyTo?: string;
  files: QueuedFile[];
  createdAt: number;
}

const KEY = "relay.outbox.v1";
const DIR = `${FileSystem.documentDirectory}outbox/`;

let queue: QueuedMessage[] = [];
let loaded = false;
const listeners = new Set<() => void>();
let draining = false;

async function persist() {
  await AsyncStorage.setItem(KEY, JSON.stringify(queue)).catch(() => {});
}

function notify() {
  for (const fn of listeners) fn();
}

export function subscribeOutbox(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    queue = raw ? (JSON.parse(raw) as QueuedMessage[]) : [];
  } catch {
    queue = [];
  }
}

export async function outboxFor(projectId: string): Promise<QueuedMessage[]> {
  await ensureLoaded();
  return queue.filter((m) => m.projectId === projectId);
}

// Stage each file under outbox/<msgId>/ so camera-roll URIs survive until the
// upload happens — picked-asset URIs can be revoked between sessions.
export async function enqueueMessage(msg: {
  projectId: string;
  conversationId: string;
  body: string;
  replyTo?: string;
  files: { uri: string; name: string; type: string }[];
}): Promise<QueuedMessage> {
  await ensureLoaded();
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const staged: QueuedFile[] = [];
  if (msg.files.length > 0) {
    await FileSystem.makeDirectoryAsync(`${DIR}${id}/`, {
      intermediates: true,
    }).catch(() => {});
    for (const f of msg.files) {
      const dest = `${DIR}${id}/${f.name}`;
      try {
        await FileSystem.copyAsync({ from: f.uri, to: dest });
        staged.push({ uri: dest, name: f.name, type: f.type });
      } catch {
        staged.push(f); // copy failed — keep original URI as best effort
      }
    }
  }
  const item: QueuedMessage = {
    id,
    projectId: msg.projectId,
    conversationId: msg.conversationId,
    body: msg.body,
    replyTo: msg.replyTo,
    files: staged,
    createdAt: Date.now(),
  };
  queue.push(item);
  await persist();
  notify();
  return item;
}

// drain replays the queue in order — first failure stops the run so ordering
// is preserved. Called after any successful API round-trip.
export async function drainOutbox(): Promise<void> {
  await ensureLoaded();
  if (draining || queue.length === 0) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const m = queue[0];
      const ids: string[] = [];
      for (const f of m.files) {
        const att = await api.upload(m.projectId, {
          uri: f.uri,
          name: f.name,
          type: f.type,
        });
        ids.push(att.id);
      }
      await api.postMessage(m.conversationId, m.body, ids, m.replyTo);
      queue.shift();
      await persist();
      // staged copies are dead weight once uploaded
      FileSystem.deleteAsync(`${DIR}${m.id}/`, { idempotent: true }).catch(
        () => {},
      );
      notify();
    }
  } catch {
    // still offline or server rejected — leave the head item for next poll
  } finally {
    draining = false;
  }
}
