import type { BotSummary } from "../shared/bot-list";
import type { SurfaceIntent } from "./intent";

// Command Center items for each bot. The client entry can't read settings, so the
// bot list comes from an RPC: fetched at start, again whenever a mounted Bots
// component sees the settings change, and on a timer for edits from other clients.

export interface BotCommandItem {
  id: string;
  title: string;
  keywords: string[];
  intent: Extract<SurfaceIntent, { kind: "new-chat" }>;
}

/** "New chat with <Bot>" for every unarchived bot, searchable by name and title. */
export function botCommandItems(bots: readonly BotSummary[]): BotCommandItem[] {
  return bots
    .filter((bot) => !bot.archived)
    .map((bot) => ({
      id: `bot-new-${bot.id}`,
      title: `New chat with ${bot.name}`,
      keywords: ["bot", "new chat", bot.name, ...(bot.title ? [bot.title] : [])],
      intent: { kind: "new-chat", botId: bot.id },
    }));
}

const changeListeners = new Set<() => void>();

/** Tells the Command Center items the bots settings changed; mounted components call it. */
export function notifyBotsChanged(): void {
  for (const listener of [...changeListeners]) listener();
}

/** Keeps one Command Center registration per item; returns the cleanup. A failed fetch keeps the current items. */
export function startBotItems({
  fetch,
  register,
  intervalMs,
}: {
  fetch: () => Promise<BotSummary[]>;
  register: (item: BotCommandItem) => () => void;
  intervalMs: number;
}): () => void {
  const live = new Map<string, { signature: string; remove: () => void }>();

  const apply = (items: BotCommandItem[]) => {
    const next = new Map(items.map((item) => [item.id, item]));
    for (const [id, entry] of live) {
      const item = next.get(id);
      if (!item || signatureOf(item) !== entry.signature) {
        entry.remove();
        live.delete(id);
      }
    }
    for (const item of items) {
      if (live.has(item.id)) continue;
      live.set(item.id, { signature: signatureOf(item), remove: register(item) });
    }
  };

  const fresh = keepFresh({ fetch: async () => botCommandItems(await fetch()), apply, intervalMs });
  return () => {
    fresh.stop();
    for (const entry of live.values()) entry.remove();
    live.clear();
  };
}

/**
 * Fetches at start, whenever the bots settings change, on a timer and on `refresh()`, and hands
 * each result to `apply`. Requests during a fetch become one more fetch; a failed fetch is
 * skipped, so the current items stay.
 */
export function keepFresh<T>({ fetch, apply, intervalMs }: { fetch: () => Promise<T>; apply: (result: T) => void; intervalMs: number }): { refresh(): void; stop(): void } {
  let stopped = false;
  let inFlight = false;
  let again = false;
  const refresh = () => {
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    fetch()
      .then(
        (result) => {
          if (!stopped) apply(result);
        },
        () => {
          // The daemon side may not be ready yet; the next tick or settings change tries again.
        },
      )
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          refresh();
        }
      });
  };

  changeListeners.add(refresh);
  const timer = setInterval(refresh, intervalMs);
  refresh();
  return {
    refresh,
    stop() {
      stopped = true;
      changeListeners.delete(refresh);
      clearInterval(timer);
    },
  };
}

function signatureOf(item: BotCommandItem): string {
  return JSON.stringify([item.title, item.keywords]);
}
