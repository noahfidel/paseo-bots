import { afterEach, describe, expect, it, vi } from "vitest";
import { attachSurface, openChatSelection, requestIntent, takeIntent, type SurfaceIntent } from "../client/intent";
import { fetchRecentChats, recentChatChanges, recentChatCount, recentChatItems, startRecentChatItems, type RecentChat, type RecentChatItem } from "../client/recent-items";
import { BotListSchema, type BotSummary } from "../shared/bot-list";
import { BOT_LABEL, botSettings } from "../shared/bot";

const bot = (patch: Partial<BotSummary> = {}): BotSummary => ({ id: "bot-1", name: "Inbox", title: "Triages mail", archived: false, ...patch });
const chat = (patch: Partial<RecentChat> & { botId?: string } = {}): RecentChat => {
  const { botId = "bot-1", ...rest } = patch;
  return {
    id: "chat-1",
    title: "Morning triage",
    labels: { [BOT_LABEL]: botId },
    archivedAt: null,
    updatedAt: "2026-11-05T10:00:00.000Z",
    lastUserMessageAt: "2026-11-05T10:00:00.000Z",
    ...rest,
  };
};

afterEach(() => {
  takeIntent();
});

describe("open-chat intent", () => {
  const bots = [{ id: "bot-1" }, { id: "bot-2" }];
  const intent = { kind: "open-chat", botId: "bot-1", chatId: "chat-1" } as const;

  it("opens the exact chat when it still exists", () => {
    expect(openChatSelection(intent, bots, ["chat-0", "chat-1"])).toEqual({ botId: "bot-1", chatId: "chat-1" });
  });

  it("opens the bot's new chat when the chat is gone", () => {
    expect(openChatSelection(intent, bots, ["chat-0"])).toEqual({ botId: "bot-1", chatId: null });
  });

  it("opens the chat when its list couldn't be read", () => {
    expect(openChatSelection(intent, bots, null)).toEqual({ botId: "bot-1", chatId: "chat-1" });
  });

  it("selects nothing when the bot is gone", () => {
    expect(openChatSelection({ ...intent, botId: "gone" }, bots, ["chat-1"])).toBeNull();
  });

  it("goes to the Bots screen the item opens", () => {
    const taken: SurfaceIntent[] = [];
    requestIntent(intent);
    attachSurface((next) => taken.push(next));
    expect(taken).toEqual([intent]);
  });
});

describe("recentChatCount", () => {
  it("defaults to 3 and stays within 1-9", () => {
    expect(recentChatCount(undefined)).toBe(3);
    expect(recentChatCount(0)).toBe(1);
    expect(recentChatCount(12)).toBe(9);
    expect(recentChatCount(4.6)).toBe(5);
    expect(recentChatCount(Number.NaN)).toBe(3);
  });
});

describe("recent chats setting", () => {
  it("keeps settings saved before it existed valid", () => {
    const parsed = botSettings.schema.parse({ bots: [], hideBotChats: true });
    expect(parsed.recentChats).toBeUndefined();
    expect(parsed.hideBotChats).toBe(true);
  });

  it("is sent with the bot list, and the list without it still parses", () => {
    expect(BotListSchema.parse({ bots: [] }).recentChats).toBeUndefined();
    expect(BotListSchema.parse({ bots: [], recentChats: 5 }).recentChats).toBe(5);
  });
});

describe("recentChatItems", () => {
  it("lists the newest chats first across bots, by last message", () => {
    const items = recentChatItems(
      [bot(), bot({ id: "bot-2", name: "Ops", title: "" })],
      [
        chat({ id: "a", lastUserMessageAt: "2026-11-05T08:00:00.000Z" }),
        chat({ id: "b", botId: "bot-2", title: "Deploy", lastUserMessageAt: "2026-11-05T09:00:00.000Z" }),
        // A routine chat with no user message falls back to its last update.
        chat({ id: "c", lastUserMessageAt: null, updatedAt: "2026-11-05T08:30:00.000Z" }),
      ],
      3,
    );
    expect(items.map((item) => item.intent.chatId)).toEqual(["b", "c", "a"]);
    expect(items[0]).toMatchObject({ title: "Recent: Ops · Deploy", intent: { kind: "open-chat", botId: "bot-2", chatId: "b" } });
  });

  it("takes only N", () => {
    const chats = ["a", "b", "c", "d"].map((id, index) => chat({ id, lastUserMessageAt: `2026-11-05T0${index}:00:00.000Z` }));
    expect(recentChatItems([bot()], chats, 2).map((item) => item.intent.chatId)).toEqual(["d", "c"]);
  });

  it("skips archived chats and chats of unknown or archived bots", () => {
    const items = recentChatItems(
      [bot(), bot({ id: "old", archived: true })],
      [chat({ id: "archived", archivedAt: "2026-11-05T11:00:00.000Z" }), chat({ id: "stranger", botId: "nobody" }), chat({ id: "retired", botId: "old" }), chat({ id: "kept" })],
      9,
    );
    expect(items.map((item) => item.intent.chatId)).toEqual(["kept"]);
  });

  it("strips the old [Bot] prefix and names an untitled chat, and is searchable by recent, bot and title", () => {
    const [titled, untitled] = recentChatItems([bot()], [chat({ id: "a", title: "[Inbox] Weekly review" }), chat({ id: "b", title: null, lastUserMessageAt: "2026-11-04T00:00:00.000Z" })], 3);
    expect(titled!.title).toBe("Recent: Inbox · Weekly review");
    expect(titled!.keywords).toEqual(expect.arrayContaining(["recent", "Inbox", "Weekly review"]));
    expect(untitled!.title).toBe("Recent: Inbox · New chat");
  });

  it("gives each slot a stable id so the items keep their order", () => {
    const items = recentChatItems([bot()], [chat({ id: "a" }), chat({ id: "b", lastUserMessageAt: "2026-11-04T00:00:00.000Z" })], 3);
    expect(items.map((item) => item.id)).toEqual(["recent-chat-1", "recent-chat-2"]);
  });
});

describe("fetchRecentChats", () => {
  it("keeps the bots whose chats came back when another bot's list fails", async () => {
    const chats = await fetchRecentChats([bot(), bot({ id: "bot-2" })], async (botId) => {
      if (botId === "bot-2") throw new Error("offline");
      return [chat({ id: "a" })];
    });
    expect(chats.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("fails when every bot's list fails, so the current items stay", async () => {
    await expect(fetchRecentChats([bot()], async () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
  });

  it("asks only for unarchived bots and returns nothing without bots", async () => {
    const fetchChats = vi.fn(async () => [chat()]);
    await fetchRecentChats([bot({ archived: true })], fetchChats);
    expect(fetchChats).not.toHaveBeenCalled();
    await expect(fetchRecentChats([], fetchChats)).resolves.toEqual([]);
  });
});

describe("recentChatChanges", () => {
  const upsert = (patch: Partial<RecentChat> & { botId?: string; status?: string } = {}) => {
    const { status = "running", ...rest } = patch;
    return { kind: "upsert" as const, agent: { ...chat(rest), status } };
  };

  it("ignores status-only updates of a bot chat it has seen", () => {
    const changed = recentChatChanges();
    expect(changed(upsert())).toBe(true);
    expect(changed(upsert({ status: "idle", updatedAt: "2026-11-05T10:00:05.000Z" }))).toBe(false);
  });

  it("notices a new title, a new message, archiving and a new chat", () => {
    const changed = recentChatChanges();
    changed(upsert());
    expect(changed(upsert({ title: "Renamed" }))).toBe(true);
    expect(changed(upsert({ title: "Renamed", lastUserMessageAt: "2026-11-05T11:00:00.000Z" }))).toBe(true);
    expect(changed(upsert({ title: "Renamed", lastUserMessageAt: "2026-11-05T11:00:00.000Z", archivedAt: "2026-11-05T12:00:00.000Z" }))).toBe(true);
    expect(changed(upsert({ id: "chat-2" }))).toBe(true);
  });

  it("counts the last update only for a chat with no user message, where it sets the order", () => {
    const changed = recentChatChanges();
    changed(upsert({ lastUserMessageAt: null }));
    expect(changed(upsert({ lastUserMessageAt: null, updatedAt: "2026-11-05T10:05:00.000Z" }))).toBe(true);
  });

  it("ignores agents that aren't bot chats and notices removals", () => {
    const changed = recentChatChanges();
    expect(changed({ kind: "upsert", agent: { ...chat(), labels: {} } })).toBe(false);
    changed(upsert());
    expect(changed({ kind: "remove", agentId: "chat-1" })).toBe(true);
    // Seen again after removal counts as new.
    expect(changed(upsert())).toBe(true);
  });
});

describe("startRecentChatItems", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  function setup(fetch: () => Promise<RecentChatItem[]>) {
    const order: string[] = [];
    const live = new Map<string, RecentChatItem>();
    const register = vi.fn((item: RecentChatItem) => {
      live.set(item.id, item);
      order.push(item.title);
      return () => live.delete(item.id);
    });
    let onAgentUpdate: () => void = () => {};
    const stop = startRecentChatItems({
      fetch,
      register,
      intervalMs: 60_000,
      debounceMs: 0,
      watchAgents: (listener) => {
        onAgentUpdate = listener;
        return () => {
          onAgentUpdate = () => {};
        };
      },
    });
    return { live, order, register, stop, agentUpdate: () => onAgentUpdate() };
  }
  const items = (titles: string[]): RecentChatItem[] =>
    titles.map((title, index) => ({ id: `recent-chat-${index + 1}`, title, keywords: [], intent: { kind: "open-chat", botId: "bot-1", chatId: title } }));

  it("re-registers every item in order when the list changes, and refreshes on agent updates", async () => {
    let titles = ["a", "b"];
    const { live, order, register, stop, agentUpdate } = setup(async () => items(titles));
    await flush();
    expect(order).toEqual(["a", "b"]);
    titles = ["b", "a"];
    agentUpdate();
    await flush();
    await flush();
    expect([...live.values()].map((item) => item.title)).toEqual(["b", "a"]);
    expect(order.slice(2)).toEqual(["b", "a"]);
    // An unchanged list isn't registered again.
    const calls = register.mock.calls.length;
    agentUpdate();
    await flush();
    await flush();
    expect(register.mock.calls.length).toBe(calls);
    stop();
    expect(live.size).toBe(0);
  });

  it("cleans up items already registered when a registration throws, and tries again next time", async () => {
    let failOn: string | null = "b";
    const live = new Map<string, RecentChatItem>();
    const register = vi.fn((item: RecentChatItem) => {
      if (item.title === failOn) throw new Error("register failed");
      live.set(item.id, item);
      return () => live.delete(item.id);
    });
    let onAgentUpdate: () => void = () => {};
    const stop = startRecentChatItems({
      fetch: async () => items(["a", "b"]),
      register,
      intervalMs: 60_000,
      debounceMs: 0,
      watchAgents: (listener) => {
        onAgentUpdate = listener;
        return () => {};
      },
    });
    await flush();
    expect(live.size).toBe(0);
    failOn = null;
    onAgentUpdate();
    await flush();
    await flush();
    expect([...live.values()].map((item) => item.title)).toEqual(["a", "b"]);
    stop();
  });

  it("keeps the current items when a fetch fails", async () => {
    let fail = false;
    const { live, stop, agentUpdate } = setup(async () => {
      if (fail) throw new Error("offline");
      return items(["a"]);
    });
    await flush();
    fail = true;
    agentUpdate();
    await flush();
    await flush();
    expect([...live.keys()]).toEqual(["recent-chat-1"]);
    stop();
  });
});
