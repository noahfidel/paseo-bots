import { describe, expect, it } from "vitest";
import { EMPTY_LIBRARY } from "../shared/bot";
import { ensureBotWorkspace, startBotChat, supportsBackgroundWorkspaces, syncBotWorkspaceTitle, withBackground, type ChatApi } from "../shared/chat";
import { makeBot } from "./helpers";

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
function fakeApi(options: { entries?: Entry[]; projects?: { projectId: string; projectRootPath: string }[]; oldHost?: boolean; hideBackgroundProjects?: boolean } = {}) {
  const entries: Entry[] = [...(options.entries ?? [])];
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
        const known = new Set(entries.filter((entry) => !(options.hideBackgroundProjects && entry.background)).map((entry) => entry.projectId));
        return { projects: (options.projects ?? []).filter((project) => known.has(project.projectId) || !options.hideBackgroundProjects) as never };
      },
    },
    workspaces: {
      list: async (listOptions) => {
        calls.list.push(listOptions ?? null);
        const wantsBackground = listOptions?.filter?.includeBackground === true;
        if (wantsBackground && options.oldHost) throw new Error(OLD_HOST);
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

  it("finds the Bots project through its background workspaces when the project list leaves it out", async () => {
    const { api, calls } = fakeApi({ entries: [{ ...backgroundInbox, workspaceDirectory: "/bots/other", title: "Other" }], projects, hideBackgroundProjects: true });
    await ensureBotWorkspace(api, makeBot(), SHARED, true);
    expect(calls.opened).toEqual([]);
    expect(calls.create[0]?.source.projectId).toBe("p1");
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

  it("falls back to a normal workspace on a host without background support", async () => {
    const { api, calls } = fakeApi({ projects, oldHost: true });
    await ensureBotWorkspace(api, makeBot(), SHARED, true);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).not.toHaveProperty("background");
    // And the lookup itself fell back to a plain list, so an existing workspace is still found.
    await ensureBotWorkspace(api, makeBot(), SHARED, true);
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

  it("still starts the chat on an old host", async () => {
    const { api } = fakeApi({ projects, oldHost: true });
    const id = await startBotChat(api, { bot: makeBot({ model: "m" }), library: EMPTY_LIBRARY, placement: SHARED, prompt: "hi", systemPrompt: "s", hideFromSidebar: true });
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
    const asked: boolean[] = [];
    const result = await withBackground(async (includeBackground) => {
      asked.push(includeBackground);
      if (includeBackground) throw new Error(OLD_HOST);
      return "plain";
    });
    expect(result).toBe("plain");
    expect(asked).toEqual([true, false]);
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
