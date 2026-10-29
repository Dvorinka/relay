import { describe, expect, it, vi } from "vitest";
import { cachePut, clearApiCache } from "./cache";

// local.ts transitively reads localStorage at module load (net.ts). Stub it
// before the import lands — Node has no DOM storage.
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
});
const { dumpLocal, importRemoteSnapshot, local, remoteOriginOf } = await import(
  "./local"
);

const O = "http://s.test";
const A = "Bearer t";

// Node has no IndexedDB — the cache/local stores run on their in-memory
// fallback, so the importer sees exactly the bodies we plant.
describe("importRemoteSnapshot", () => {
  it("hydrates projects, conversations, messages, issues from cached GETs", async () => {
    await clearApiCache();
    await cachePut(
      `${A}|${O}/api/auth/session`,
      JSON.stringify({
        user: {
          id: "u9",
          email: "me@x.io",
          name: "Remote Me",
          avatar_url: null,
          created_at: "2026-01-01T00:00:00Z",
        },
        workspaces: [
          {
            id: "w1",
            name: "Team",
            slug: "team",
            role: "owner",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    await cachePut(
      `${A}|${O}/api/projects`,
      JSON.stringify({
        projects: [
          {
            id: "p1",
            name: "Proj",
            key: "PRJ",
            workspace_id: "w1",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    await cachePut(
      `${A}|${O}/api/projects/p1/conversation`,
      JSON.stringify({
        id: "c1",
        project_id: "p1",
        kind: "project",
        issue_id: null,
        created_at: "2026-01-01T00:00:00Z",
      }),
    );
    await cachePut(
      `${A}|${O}/api/conversations/c1/messages?limit=50`,
      JSON.stringify({
        messages: [
          {
            id: "m1",
            conversation_id: "c1",
            author: {
              kind: "user",
              id: "u9",
              name: "Remote Me",
              avatar_url: null,
            },
            body: "hi there",
            tags: [],
            parent: null,
            attachments: [
              {
                id: "a1",
                project_id: "p1",
                filename: "f.png",
                content_type: "image/png",
                size_bytes: 3,
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
            reactions: [],
            created_at: "2026-01-01T00:00:01Z",
            edited_at: null,
            agent_read: false,
            read_by: [],
            forwarded: null,
          },
        ],
      }),
    );
    await cachePut(
      `${A}|${O}/api/projects/p1/issues`,
      JSON.stringify({
        issues: [
          {
            id: "i1",
            project_id: "p1",
            key: "PRJ-4",
            title: "Fix the thing",
            description: "",
            status: "todo",
            priority: "medium",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    // Another principal's and another server's entries must not leak in.
    await cachePut(
      `Bearer other|${O}/api/projects`,
      JSON.stringify({ projects: [{ id: "pX", name: "Stranger" }] }),
    );
    await cachePut(
      `${A}|http://other.test/api/projects`,
      JSON.stringify({ projects: [{ id: "pY", name: "Elsewhere" }] }),
    );

    const n = await importRemoteSnapshot(O, A);
    const db = dumpLocal();

    expect(n).toBeGreaterThan(0);
    expect(db.user.name).toBe("Remote Me");
    expect(db.user.id).toBe("u9"); // remote id kept — messages stay "mine"
    expect(db.workspace.name).toBe("Team");
    expect(db.projects.map((p) => p.id)).toContain("p1");
    expect(db.projects.map((p) => p.id)).not.toContain("pX");
    expect(db.projects.map((p) => p.id)).not.toContain("pY");
    expect(db.conversations.map((c) => c.id)).toContain("c1");
    expect(db.messages.map((m) => m.id)).toContain("m1");
    expect(db.issues.map((i) => i.key)).toContain("PRJ-4");
    // Issue counter continues past the highest imported key.
    expect(db.counters["p1"]).toBe(5);
    // Attachment metadata lands with a resolvable remote path.
    expect(db.attachments["a1"]?.url).toBe(
      "/api/projects/p1/attachments/a1/download",
    );
    // Everything imported is tagged remote so sync won't re-create it.
    for (const id of ["p1", "c1", "m1", "i1", "a1"]) {
      expect(remoteOriginOf(id)).toBe(O);
    }
    expect(remoteOriginOf("pX")).toBeUndefined();
  });
});

describe("local channels", () => {
  it("lists one row per project and keeps channels off the main chat", async () => {
    const p = await local.createProject({ name: "Phone Nav Test" });
    dumpLocal().projects.push({ ...p });
    const listed = await local.listProjects();
    expect(listed.projects.filter((x) => x.id === p.id)).toHaveLength(1);

    const main = await local.projectConversation(p.id);
    const { channel } = await local.createChannel(p.id, "  ops  ");
    expect(channel.name).toBe("ops");
    expect((await local.projectConversation(p.id)).id).toBe(main.id);
    expect((await local.listChannels(p.id)).channels.map((c) => c.name)).toEqual([
      "ops",
    ]);
    await expect(local.createChannel(p.id, "OPS")).rejects.toThrow(
      /already exists/,
    );
    await local.deleteChannel(channel.id);
    expect((await local.listChannels(p.id)).channels).toHaveLength(0);
  });
});
