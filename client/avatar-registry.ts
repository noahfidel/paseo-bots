import { onBotsChanged } from "./bot-items";
import { avatarSvg, safeImageUrl } from "../shared/avatar-svg";
import type { BotSummary } from "../shared/bot-list";

// Publishes bot avatars on globalThis.__paseoBotsAvatars for other plugins in the same app
// (see docs/avatars-api.md). Loads the bot list at startup, keeps it fresh on focus and a timer.

export interface PaseoBotsAvatars {
  version: 1;
  /** null when the bot is unknown (or not loaded yet). */
  get(botId: string, opts: { dark: boolean }): { name: string; svg?: string; imageUrl?: string } | null;
  /** Called whenever the bot list or any avatar changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const GLOBAL_KEY = "__paseoBotsAvatars";

// A re-run of the client entry replaces the previous registration: stop the old one first.
const running = new WeakMap<object, () => void>();

export function installAvatarRegistry({
  fetch,
  intervalMs,
  target = globalThis as unknown as Record<string, unknown>,
  onFocus = windowFocus,
}: {
  fetch: () => Promise<BotSummary[]>;
  intervalMs: number;
  target?: Record<string, unknown>;
  onFocus?: (callback: () => void) => () => void;
}): () => void {
  running.get(target)?.();

  let bots = new Map<string, BotSummary>();
  let signature = "";
  let stopped = false;
  const listeners = new Set<() => void>();

  const api: PaseoBotsAvatars = {
    version: 1,
    get(botId, { dark }) {
      const bot = bots.get(botId);
      if (!bot?.avatar) return null;
      const imageUrl = safeImageUrl(bot.avatar.imageUrl);
      if (imageUrl) return { name: bot.name, imageUrl };
      return { name: bot.name, svg: avatarSvg(bot.avatar, { dark }) };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const apply = (next: BotSummary[]) => {
    const nextSignature = JSON.stringify(next.map((bot) => [bot.id, bot.name, bot.avatar]));
    if (nextSignature === signature) return;
    signature = nextSignature;
    bots = new Map(next.map((bot) => [bot.id, bot]));
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One consumer's failure must not starve the others.
      }
    }
  };

  // Focus, the timer and the first load can overlap; a request during a fetch becomes one more fetch.
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
        (next) => {
          if (!stopped) apply(next);
        },
        () => {
          // The daemon side may not be ready yet; keep what we have and try again on the next tick.
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

  target[GLOBAL_KEY] = api;
  const offFocus = onFocus(refresh);
  // Edits made in the Bots screen show up at once, not on the next tick.
  const offChanged = onBotsChanged(refresh);
  const timer = setInterval(refresh, intervalMs);
  refresh();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    offFocus();
    offChanged();
    listeners.clear();
    if (target[GLOBAL_KEY] === api) delete target[GLOBAL_KEY];
    if (running.get(target) === stop) running.delete(target);
  };
  running.set(target, stop);
  return stop;
}

function windowFocus(callback: () => void): () => void {
  const win = (globalThis as { window?: { addEventListener?: (type: string, cb: () => void) => void; removeEventListener?: (type: string, cb: () => void) => void } }).window;
  if (!win?.addEventListener) return () => {};
  win.addEventListener("focus", callback);
  return () => win.removeEventListener?.("focus", callback);
}
