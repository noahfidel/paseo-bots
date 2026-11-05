import type { BotSummary } from "../shared/bot-list";
import { BOT_LABEL } from "../shared/bot";
import { displayTitle } from "../shared/chat";
import { keepFresh } from "./bot-items";
import type { SurfaceIntent } from "./intent";

// "Recent: <Bot> · <chat>" Command Center items for the most recently active bot chats on the
// local host, across bots. Selecting one opens the Bots screen on that chat.

export const DEFAULT_RECENT_CHATS = 3;

/** The "Recent chats in Command Center" setting as a count: 3 when missing, within 1-9. */
export function recentChatCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RECENT_CHATS;
  return Math.min(9, Math.max(1, Math.round(value)));
}

/** The fields of a Paseo agent the items need. */
export interface RecentChat {
  id: string;
  title: string | null;
  labels: Record<string, string>;
  archivedAt?: string | null;
  updatedAt: string;
  lastUserMessageAt: string | null;
}

export interface RecentChatItem {
  id: string;
  title: string;
  keywords: string[];
  intent: Extract<SurfaceIntent, { kind: "open-chat" }>;
}

/**
 * When the user last used a chat: their last message, so a chat that only changed status (a
 * reload, a provider reconnect) doesn't jump ahead. Chats with no user message yet (a routine's
 * results chat) fall back to their last update.
 */
function activityOf(chat: RecentChat): number {
  return Date.parse(chat.lastUserMessageAt ?? chat.updatedAt) || 0;
}

/** The `count` most recently active unarchived chats of unarchived bots, newest first. */
export function recentChatItems(bots: readonly BotSummary[], chats: readonly RecentChat[], count: number): RecentChatItem[] {
  const names = new Map(bots.filter((bot) => !bot.archived).map((bot) => [bot.id, bot.name]));
  return chats
    .filter((chat) => !chat.archivedAt && names.has(chat.labels[BOT_LABEL] ?? ""))
    .sort((a, b) => activityOf(b) - activityOf(a))
    .slice(0, count)
    .map((chat, index) => {
      const botId = chat.labels[BOT_LABEL]!;
      const botName = names.get(botId)!;
      const title = displayTitle(chat.title);
      return {
        // Slots, not chat ids: a changed list is registered again in order (see startRecentChatItems).
        id: `recent-chat-${index + 1}`,
        title: `Recent: ${botName} · ${title}`,
        keywords: ["recent", "bot", "chat", botName, title],
        intent: { kind: "open-chat", botId, chatId: chat.id },
      };
    });
}

/**
 * Every unarchived bot's chats, read one bot at a time. A bot whose list fails is left out;
 * when every list fails this fails too, so the current items stay.
 */
export async function fetchRecentChats<Chat>(bots: readonly BotSummary[], fetchChats: (botId: string) => Promise<Chat[]>): Promise<Chat[]> {
  const live = bots.filter((bot) => !bot.archived);
  if (!live.length) return [];
  const results = await Promise.allSettled(live.map((bot) => fetchChats(bot.id)));
  const lists = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  if (!lists.length) throw (results[0] as PromiseRejectedResult).reason;
  return lists.flat();
}

/** An agent update as far as the recent list cares. */
export type RecentChatUpdate = { kind: "upsert"; agent: RecentChat } | { kind: "remove"; agentId: string };

/**
 * Decides which agent updates can change the recent list, so status updates while a chat
 * streams don't refetch every bot's chats: a new or removed bot chat, a new title, archiving,
 * or a change to the time it's ordered by. Remembers what it last saw of each bot chat.
 */
export function recentChatChanges(): (update: RecentChatUpdate) => boolean {
  const seen = new Map<string, string>();
  return (update) => {
    if (update.kind === "remove") {
      // A removal doesn't say whose agent it was; one we never saw may still be a bot chat.
      seen.delete(update.agentId);
      return true;
    }
    const { agent } = update;
    const botId = agent.labels[BOT_LABEL];
    if (!botId) return false;
    // updatedAt orders a chat only while it has no user message; otherwise it moves with every status change.
    const key = JSON.stringify([botId, agent.title, agent.archivedAt ?? null, agent.lastUserMessageAt ?? agent.updatedAt]);
    if (seen.get(agent.id) === key) return false;
    seen.set(agent.id, key);
    return true;
  };
}

/**
 * Keeps the recent-chat registrations current; returns the cleanup. Fetches like the bot items
 * (start, settings change, timer) and shortly after a bot chat changes. When the list changes,
 * every item is registered again so the Command Center keeps them newest first. A failed fetch
 * keeps the current items.
 */
export function startRecentChatItems({
  fetch,
  register,
  intervalMs,
  debounceMs,
  watchAgents,
}: {
  fetch: () => Promise<RecentChatItem[]>;
  register: (item: RecentChatItem) => () => void;
  intervalMs: number;
  debounceMs: number;
  /** Calls the listener when a bot chat may have changed; returns the cleanup. */
  watchAgents: (listener: () => void) => () => void;
}): () => void {
  let removers: (() => void)[] = [];
  let signature = "";
  const removeAll = () => {
    for (const remove of removers) remove();
    removers = [];
  };

  const fresh = keepFresh({
    fetch,
    intervalMs,
    apply: (items) => {
      const next = JSON.stringify(items.map((item) => [item.title, item.keywords, item.intent]));
      if (next === signature) return;
      removeAll();
      signature = "";
      try {
        for (const item of items) removers.push(register(item));
        signature = next;
      } catch (error) {
        // Drop the half-registered list; the empty signature makes the next fetch try again.
        removeAll();
        console.error("[paseo-bots] Recent chat items couldn't be registered", error);
      }
    },
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const stopWatching = watchAgents(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fresh.refresh();
    }, debounceMs);
  });

  return () => {
    fresh.stop();
    stopWatching();
    if (timer) clearTimeout(timer);
    removeAll();
  };
}
