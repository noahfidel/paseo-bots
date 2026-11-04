import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_LIBRARY } from "../shared/bot";
import { backgroundProbe, ensureBotWorkspace, startBotChat, supportsBackgroundWorkspaces, syncBotWorkspaceTitle, withBackground, withBackgroundFilter, type ChatApi } from "../shared/chat";
import { makeBot } from "./helpers";

beforeEach(() => {
  backgroundProbe.delays = [0, 0];
});

const OLD_HOST = "Update the host to use background workspaces.";
const SHARED = { path: "/bots/inbox", projectRoot: "/bots" };
const CUSTOM = { path: "/home/me/.claude", projectRoot: null };

interface Entry {
  id: string;
  projectId: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  title?: string | null;
  background?: boolean;
}

/** An in-memory Paseo that behaves like the real one: background workspaces are hidden unless asked for, and an old host rejects both ways of asking. */
function fakeApi(options: { entries?: Entry[]; projects?: { projectId: string; projectRootPath: string }[]; oldHost?: boolean; slowCreate?: boolean; reconnectingFor?: number } = {}) {
  const entries: Entry[] = [...(options.entries ?? [])];
  let reconnecting = options.reconnectingFor ?? 0;
  const calls = { list: [] as unknown[], create: [] as { background?: boolean; title: string; source: { path: string; projectId?: string } }[], titles: [] as string[], opened: [] as string[], agents: [] as string[] };
  const handle = (entry: Entry) => ({
    current: () => entry,
    refresh: async () => entry,
    setTitle: async (title: string) => {
      calls.titles.push(`${entry.id}:${title}`);
    },
    archive: async () => undefined,
    agents: {
      create: async () => {
        calls.agents.push(entry.id);
        return { id: `agent-in-${entry.id}` };
      },
    },
  });
  const api: ChatApi = {
    projects: {
      list: async () => {
        return { projects: (options.projects ?? []) as never };
      },
    },
    workspaces: {
      list: async (listOptions) => {
        calls.list.push(listOptions ?? null);
        const wantsBackground = listOptions?.filter?.includeBackground === true;
        if (wantsBackground && (options.oldHost || reconnecting > 0)) {
          reconnecting -= 1;
          throw new Error(OLD_HOST);
        }
        return { entries: entries.filter((entry) => wantsBackground || !entry.background) as never };
      },
      ref: (workspace) => handle(typeof workspace === "string" ? entries.find((entry) => entry.id === workspace)! : (workspace as Entry)),
      open: async (path) => {
        calls.opened.push(path);
        const entry: Entry = { id: `root-${entries.length}`, projectId: "p-new", projectRootPath: path, workspaceDirectory: path, title: null };
        entries.push(entry);
        return handle(entry);
      },
      create: async (create) => {
        if (create.background !== undefined && options.oldHost) throw new Error(OLD_HOST);
        calls.create.push(create);
        if (options.slowCreate) await new Promise((resolve) => setTimeout(resolve, 20));
        const entry: Entry = {
          id: `ws-${entries.length}`,
          projectId: create.source.projectId ?? "p-custom",
          projectRootPath: create.source.path,
          workspaceDirectory: create.source.path,
          title: create.title,
          ...(create.background ? { background: true } : {}),
        };
        entries.push(entry);
        return handle(entry);
      },
    },
    providers: { snapshot: async () => ({ entries: [] }) },
  };
  return { api, calls, entries };
}

const visibleInbox: Entry = { id: "visible", projectId: "p1", projectRootPath: "/bots", workspaceDirectory: "/bots/inbox", title: "Inbox" };
const backgroundInbox: Entry = { id: "hidden", projectId: "p1", projectRootPath: "/bots", workspaceDirectory: "/bots/inbox", title: "Inbox", background: true };
const projects = [{ projectId: "p1", projectRootPath: "/bots" }];

describe("ensureBotWorkspace", () => {
  it("creates a normal workspace when the setting is off", async () => {
    const { api, calls } = fakeApi({ projects });
    await ensureBotWorkspace(api, makeBot(), SHARED, false);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).not.toHaveProperty("background");
  });

  it("creates a background workspace when the setting is on", async () => {
    const { api, calls } = fakeApi({ projects });
    await ensureBotWorkspace(api, makeBot(), SHARED, true);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]?.background).toBe(true);
    expect(calls.create[0]?.source).toEqual({ kind: "directory", path: "/bots/inbox", projectId: "p1" });
  });

  it("reuses an existing background workspace instead of creating a duplicate", async () => {
    const { api, calls, entries } = fakeApi({ entries: [backgroundInbox], projects });
    await ensureBotWorkspace(api, makeBot(), SHARED, true);
    await ensureBotWorkspace(api, makeBot(), SHARED, true);
    expect(calls.create).toHaveLength(0);
    expect(entries).toHaveLength(1);
  });

  it("reuses a background workspace even after the setting is turned off", async () => {
    const { api, calls } = fakeApi({ entries: [backgroundInbox], projects });
    await ensureBotWorkspace(api, makeBot(), SHARED, false);
    expect(calls.create).toHaveLength(0);
  });

  it("keeps using the visible workspace when the setting is off", async () => {
    const { api, calls } = fakeApi({ entries: [backgroundInbox, visibleInbox], projects });
    const workspace = await ensureBotWorkspace(api, makeBot(), SHARED, false);
    expect(workspace.current()?.background).toBeUndefined();
    expect(calls.create).toHaveLength(0);
  });

  it("migrates: with the setting on and only a visible workspace, creates a background one and leaves the old one alone", async () => {
    const { api, calls, entries } = fakeApi({ entries: [visibleInbox], projects });
    const workspace = await ensureBotWorkspace(api, makeBot(), SHARED, true);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]?.background).toBe(true);
    expect(workspace.current()?.background).toBe(true);
    expect(entries.find((entry) => entry.id === "visible")).toEqual(visibleInbox);
    // The next chat finds the background one and creates nothing more.
    await ensureBotWorkspace(api, makeBot(), SHARED, true);
    expect(calls.create).toHaveLength(1);
  });

  it("prefers the background workspace when both exist and the setting is on", async () => {
    const { api, calls } = fakeApi({ entries: [visibleInbox, backgroundInbox], projects });
    const workspace = await ensureBotWorkspace(api, makeBot(), SHARED, true);
    expect(workspace.current()?.id).toBe("hidden");
    expect(calls.create).toHaveLength(0);
  });

  it("lists with background workspaces included", async () => {
    const { api, calls } = fakeApi({ entries: [backgroundInbox], projects });
    await ensureBotWorkspace(api, makeBot(), SHARED, true);
    expect(calls.list[0]).toEqual({ filter: { includeBackground: true } });
  });

  it("matches a custom-folder bot by title and leaves other workspaces in that folder alone", async () => {
    const other: Entry = { id: "other", projectId: "p2", projectRootPath: "/home/me/.claude", workspaceDirectory: "/home/me/.claude", title: "Something else" };
    const { api, calls } = fakeApi({ entries: [other] });
    const workspace = await ensureBotWorkspace(api, makeBot(), CUSTOM, true);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({ title: "Inbox", background: true, source: { path: "/home/me/.claude" } });
    expect(calls.create[0]?.source).not.toHaveProperty("projectId");
    expect(workspace.current()?.id).not.toBe("other");
    expect(calls.titles).toEqual([]);
  });

  it("fails with a clear error on a host without background support instead of creating a visible workspace", async () => {
    const { api, calls } = fakeApi({ projects, oldHost: true });
    await expect(ensureBotWorkspace(api, makeBot(), SHARED, true)).rejects.toThrow(/0\.13\.2/);
    expect(calls.create).toHaveLength(0);
  });

  it("still works as before on a host without background support when the setting is off", async () => {
    const { api, calls } = fakeApi({ projects, oldHost: true });
    await ensureBotWorkspace(api, makeBot(), SHARED, false);
    await ensureBotWorkspace(api, makeBot(), SHARED, false);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).not.toHaveProperty("background");
  });

  it("does not mistake a reconnect for an old host: waits, then finds the hidden workspace and creates nothing", async () => {
    const { api, calls } = fakeApi({ entries: [backgroundInbox], projects, reconnectingFor: 2 });
    const workspace = await ensureBotWorkspace(api, makeBot(), SHARED, true);
    expect(workspace.current()?.id).toBe("hidden");
    expect(calls.create).toHaveLength(0);
  });

  it("never downgrades once the host has been seen supporting background workspaces", async () => {
    const fake = fakeApi({ entries: [backgroundInbox], projects });
    await ensureBotWorkspace(fake.api, makeBot(), SHARED, true);
    // The connection drops for longer than the wait: the chat fails instead of listing without hidden workspaces.
    const seen = fake.api;
    let failing = true;
    const original = seen.workspaces.list;
    seen.workspaces.list = async (options) => {
      if (failing && options?.filter?.includeBackground) throw new Error(OLD_HOST);
      return original(options);
    };
    await expect(ensureBotWorkspace(seen, makeBot(), SHARED, true)).rejects.toThrow();
    expect(fake.calls.create).toHaveLength(0);
    failing = false;
    await ensureBotWorkspace(seen, makeBot(), SHARED, true);
    expect(fake.calls.create).toHaveLength(0);
  });

  it("does not create two workspaces when two chats start for the same bot at once", async () => {
    const { api, calls } = fakeApi({ projects, slowCreate: true });
    await Promise.all([ensureBotWorkspace(api, makeBot(), SHARED, true), ensureBotWorkspace(api, makeBot(), SHARED, true)]);
    expect(calls.create).toHaveLength(1);
  });

  it("lets different bots start at the same time", async () => {
    const { api, calls } = fakeApi({ projects, slowCreate: true });
    await Promise.all([
      ensureBotWorkspace(api, makeBot({ id: "a", name: "A" }), { path: "/bots/a", projectRoot: "/bots" }, true),
      ensureBotWorkspace(api, makeBot({ id: "b", name: "B" }), { path: "/bots/b", projectRoot: "/bots" }, true),
    ]);
    expect(calls.create).toHaveLength(2);
  });

  it("keeps going after a failed start", async () => {
    const { api, calls } = fakeApi({ projects, oldHost: true });
    await expect(ensureBotWorkspace(api, makeBot(), SHARED, true)).rejects.toThrow();
    await ensureBotWorkspace(api, makeBot(), SHARED, false);
    expect(calls.create).toHaveLength(1);
  });
});

describe("startBotChat", () => {
  it("starts the chat in a background workspace when asked", async () => {
    const { api, calls } = fakeApi({ projects });
    const id = await startBotChat(api, { bot: makeBot({ model: "m" }), library: EMPTY_LIBRARY, placement: SHARED, prompt: "hi", systemPrompt: "s", hideFromSidebar: true });
    expect(calls.create[0]?.background).toBe(true);
    expect(id).toMatch(/^agent-in-/);
  });

  it("still starts the chat on an old host when the setting is off", async () => {
    const { api } = fakeApi({ projects, oldHost: true });
    const id = await startBotChat(api, { bot: makeBot({ model: "m" }), library: EMPTY_LIBRARY, placement: SHARED, prompt: "hi", systemPrompt: "s" });
    expect(id).toMatch(/^agent-in-/);
  });
});

describe("syncBotWorkspaceTitle", () => {
  it("renames background workspaces too", async () => {
    const { api, calls } = fakeApi({ entries: [{ ...backgroundInbox, title: "Old name" }], projects });
    await syncBotWorkspaceTitle(api, makeBot(), SHARED);
    expect(calls.titles).toEqual(["hidden:Inbox"]);
  });
});

describe("withBackground", () => {
  it("asks for background workspaces first and retries without them on an old host", async () => {
    backgroundProbe.delays = [];
    const asked: boolean[] = [];
    const result = await withBackground(async (includeBackground) => {
      asked.push(includeBackground);
      if (includeBackground) throw new Error(OLD_HOST);
      return "plain";
    });
    expect(result).toBe("plain");
    expect(asked).toEqual([true, false]);
  });

  it("waits out a reconnect: a guard error that clears is retried with background workspaces, never downgraded", async () => {
    let failures = 2;
    const asked: boolean[] = [];
    const result = await withBackground(async (includeBackground) => {
      asked.push(includeBackground);
      if (includeBackground && failures-- > 0) throw new Error(OLD_HOST);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(asked).toEqual([true, true, true]);
  });

  it("passes other errors through", async () => {
    await expect(
      withBackground(async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
  });
});

describe("supportsBackgroundWorkspaces", () => {
  it("is true on a host that lists background workspaces", async () => {
    expect(await supportsBackgroundWorkspaces(fakeApi().api)).toBe(true);
  });
  it("is false on an old host", async () => {
    expect(await supportsBackgroundWorkspaces(fakeApi({ oldHost: true }).api)).toBe(false);
  });
});

describe("withBackgroundFilter", () => {
  it("adds includeBackground to an agent filter when asked, so chats in hidden workspaces are listed", () => {
    expect(withBackgroundFilter({ labels: { a: "b" } }, true)).toEqual({ labels: { a: "b" }, includeBackground: true });
  });
  it("leaves the filter as it was for a host that doesn't know the option", () => {
    expect(withBackgroundFilter({ labels: { a: "b" } }, false)).toEqual({ labels: { a: "b" } });
  });
  it("retries a chat listing without the option on an old host", async () => {
    const filters: unknown[] = [];
    const list = async (filter: object) => {
      filters.push(filter);
      if ("includeBackground" in filter) throw new Error(OLD_HOST);
      return "chats";
    };
    expect(await withBackground((include) => list(withBackgroundFilter({ includeArchived: true }, include)))).toBe("chats");
    expect(filters.at(-1)).toEqual({ includeArchived: true });
    expect(filters[0]).toEqual({ includeArchived: true, includeBackground: true });
  });
});
