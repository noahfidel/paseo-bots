import { OPEN_CHAT_SCREEN_ID } from "./open-chat";

// Publishes each chat the Bots screen shows on globalThis.__paseoBotsChatOpens, so another plugin
// (the workspace switcher) can treat it as a visit; see docs/chat-opens-api.md.

export interface PaseoBotsChatOpen {
  serverId: string;
  workspaceId: string;
  agentId: string;
  /** Epoch ms. */
  at: number;
}

export interface PaseoBotsChatOpens {
  version: 1;
  /** Most recent first, at most 20. */
  recent(): PaseoBotsChatOpen[];
  /** Called after each new open; returns an unsubscribe. */
  subscribe(listener: (open: PaseoBotsChatOpen) => void): () => void;
  /** Screen IDs of this plugin that only pass through (open and immediately navigate away). Consumers must never record them as visits. */
  passThroughScreens: string[];
}

/** The published object plus the writer this plugin's own copies share; consumers ignore `record`. */
interface Registry extends PaseoBotsChatOpens {
  record(open: PaseoBotsChatOpen): void;
}

export const MAX_CHAT_OPENS = 20;
const GLOBAL_KEY = "__paseoBotsChatOpens";

type Target = Record<string, unknown>;
const globalTarget = () => globalThis as unknown as Target;

function isRegistry(value: unknown): value is Registry {
  const candidate = value as Partial<Registry> | undefined;
  return !!candidate && candidate.version === 1 && typeof candidate.record === "function";
}

function createRegistry(): Registry {
  let opens: PaseoBotsChatOpen[] = [];
  const listeners = new Set<(open: PaseoBotsChatOpen) => void>();
  return {
    version: 1,
    recent: () => [...opens],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    passThroughScreens: [OPEN_CHAT_SCREEN_ID],
    record(open) {
      opens = [open, ...opens].slice(0, MAX_CHAT_OPENS);
      for (const listener of [...listeners]) {
        try {
          listener(open);
        } catch {
          // One consumer's failure must not starve the others.
        }
      }
    },
  };
}

/**
 * Publishes the registry. Paseo re-runs the client after navigations and once per connected host, all
 * sharing one global: a version 1 object already there keeps its history and listeners.
 */
export function installChatOpens(target: Target = globalTarget()): Registry {
  const existing = target[GLOBAL_KEY];
  if (isRegistry(existing)) return existing;
  const registry = createRegistry();
  target[GLOBAL_KEY] = registry;
  return registry;
}

export function publishChatOpen(open: PaseoBotsChatOpen, target: Target = globalTarget()): void {
  installChatOpens(target).record(open);
}

/** What to record for the chat the Bots screen shows, or null: no chat yet, or its workspace is not known. */
export function chatOpenToRecord({
  serverId,
  chatId,
  workspaceId,
  now,
}: {
  serverId: string;
  chatId: string | null;
  workspaceId: string | undefined;
  now: number;
}): PaseoBotsChatOpen | null {
  if (!chatId || !workspaceId) return null;
  return { serverId, workspaceId, agentId: chatId, at: now };
}
