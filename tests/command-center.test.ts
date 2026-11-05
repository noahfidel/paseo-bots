import { afterEach, describe, expect, it, vi } from "vitest";
import { botCommandItems, notifyBotsChanged, startBotItems, type BotCommandItem } from "../client/bot-items";
import { onIntent, openBotSelection, requestIntent, takeIntent, type SurfaceIntent } from "../client/intent";
import { BotListSchema, botSummaries, type BotSummary } from "../shared/bot-list";
import { makeBot } from "./helpers";

const summary = (patch: Partial<BotSummary> = {}): BotSummary => ({ id: "bot-1", name: "Inbox", title: "Triages mail", archived: false, ...patch });

afterEach(() => {
  takeIntent();
});

describe("surface intents", () => {
  it("keeps an intent until a surface takes it, once", () => {
    requestIntent({ kind: "new-bot" });
    expect(takeIntent()).toEqual({ kind: "new-bot" });
    expect(takeIntent()).toBeNull();
  });

  it("hands an intent requested while a surface is open to its listener", () => {
    const seen: (SurfaceIntent | null)[] = [];
    const stop = onIntent(() => seen.push(takeIntent()));
    requestIntent({ kind: "open-bot", botId: "bot-1", chat: "latest" });
    expect(seen).toEqual([{ kind: "open-bot", botId: "bot-1", chat: "latest" }]);
    expect(takeIntent()).toBeNull();
    stop();
    requestIntent({ kind: "new-bot" });
    expect(seen).toHaveLength(1);
    expect(takeIntent()).toEqual({ kind: "new-bot" });
  });
});

describe("openBotSelection", () => {
  const bots = [{ id: "bot-1" }, { id: "bot-2" }];
  const chats = [{ id: "newest" }, { id: "older" }];

  it("opens the bot on its most recent chat", () => {
    expect(openBotSelection({ kind: "open-bot", botId: "bot-1", chat: "latest" }, bots, chats)).toEqual({ botId: "bot-1", chatId: "newest" });
  });

  it("opens the bot's new chat when it has none, or when asked for one", () => {
    expect(openBotSelection({ kind: "open-bot", botId: "bot-1", chat: "latest" }, bots, [])).toEqual({ botId: "bot-1", chatId: null });
    expect(openBotSelection({ kind: "open-bot", botId: "bot-1", chat: "new" }, bots, chats)).toEqual({ botId: "bot-1", chatId: null });
  });

  it("selects nothing for a bot that no longer exists", () => {
    expect(openBotSelection({ kind: "open-bot", botId: "gone", chat: "latest" }, bots, chats)).toBeNull();
  });
});

describe("botSummaries", () => {
  it("returns only what the Command Center needs", () => {
    const values = { bots: [makeBot({ id: "a", name: "Ada", title: "Helper", soul: "secret instructions", archived: true })] };
    const result = botSummaries(values);
    expect(result).toEqual([{ id: "a", name: "Ada", title: "Helper", archived: true }]);
    expect(BotListSchema.parse({ bots: result }).bots[0]).not.toHaveProperty("soul");
  });
});

describe("botCommandItems", () => {
  it("adds an open and a new-chat item per bot, searchable by name and title", () => {
    const items = botCommandItems([summary()]);
    expect(items.map((item) => [item.id, item.title, item.intent])).toEqual([
      ["bot-open-bot-1", "Inbox", { kind: "open-bot", botId: "bot-1", chat: "latest" }],
      ["bot-new-bot-1", "New chat with Inbox", { kind: "open-bot", botId: "bot-1", chat: "new" }],
    ]);
    expect(items[0]!.keywords).toEqual(expect.arrayContaining(["Inbox", "Triages mail"]));
  });

  it("leaves out archived bots", () => {
    expect(botCommandItems([summary({ archived: true }), summary({ id: "bot-2", name: "Ops" })]).map((item) => item.id)).toEqual(["bot-open-bot-2", "bot-new-bot-2"]);
  });

  it("leaves an empty title out of the keywords", () => {
    expect(botCommandItems([summary({ title: "" })])[0]!.keywords).not.toContain("");
  });
});

describe("startBotItems", () => {
  function setup(fetch: () => Promise<BotSummary[]>) {
    const live = new Map<string, BotCommandItem>();
    const register = vi.fn((item: BotCommandItem) => {
      live.set(item.id, item);
      return () => live.delete(item.id);
    });
    const stop = startBotItems({ fetch, register, intervalMs: 60_000 });
    return { live, register, stop };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers items for the bots fetched at start", async () => {
    const { live, stop } = setup(async () => [summary()]);
    await flush();
    expect([...live.keys()]).toEqual(["bot-open-bot-1", "bot-new-bot-1"]);
    stop();
    expect(live.size).toBe(0);
  });

  it("re-registers a renamed bot and removes a deleted one when settings change", async () => {
    let bots = [summary(), summary({ id: "bot-2", name: "Ops" })];
    const { live, register, stop } = setup(async () => bots);
    await flush();
    bots = [summary({ name: "Mail" })];
    notifyBotsChanged();
    await flush();
    expect([...live.values()].map((item) => item.title)).toEqual(["Mail", "New chat with Mail"]);
    // Unchanged items aren't registered again.
    const calls = register.mock.calls.length;
    notifyBotsChanged();
    await flush();
    expect(register.mock.calls.length).toBe(calls);
    stop();
  });

  it("removes a bot's items once it is archived", async () => {
    let bots = [summary()];
    const { live, stop } = setup(async () => bots);
    await flush();
    bots = [summary({ archived: true })];
    notifyBotsChanged();
    await flush();
    expect(live.size).toBe(0);
    stop();
  });

  it("keeps the current items when a fetch fails and retries on the next tick", async () => {
    vi.useFakeTimers();
    let fail = false;
    let name = "Inbox";
    const { live, stop } = setup(async () => {
      if (fail) throw new Error("daemon not ready");
      return [summary({ name })];
    });
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    name = "Mail";
    await vi.advanceTimersByTimeAsync(60_000);
    expect([...live.values()].map((item) => item.title)).toEqual(["Inbox", "New chat with Inbox"]);
    fail = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect([...live.values()].map((item) => item.title)).toEqual(["Mail", "New chat with Mail"]);
    stop();
  });

  it("folds change notices that arrive during a fetch into one more fetch", async () => {
    const fetch = vi.fn(async () => [summary()]);
    const { stop } = setup(fetch);
    notifyBotsChanged();
    notifyBotsChanged();
    notifyBotsChanged();
    await flush();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops the timer and listeners on cleanup", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => [summary()]);
    const { stop } = setup(fetch);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    const calls = fetch.mock.calls.length;
    notifyBotsChanged();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("doesn't register items from a fetch that finishes after cleanup", async () => {
    let resolve: (bots: BotSummary[]) => void = () => {};
    const { live, stop } = setup(() => new Promise((done) => (resolve = done)));
    stop();
    resolve([summary()]);
    await flush();
    expect(live.size).toBe(0);
  });
});
