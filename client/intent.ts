// Command Center items can open the surface but can't pass it arguments.
// They leave an intent here; the surface takes it when it mounts, or, when a
// Bots screen is already open, as soon as it's requested.

export type SurfaceIntent = { kind: "new-bot" } | { kind: "open-bot"; botId: string; chat: "latest" | "new" };

let pending: SurfaceIntent | null = null;
const listeners = new Set<() => void>();

export function requestIntent(intent: SurfaceIntent): void {
  pending = intent;
  for (const listener of [...listeners]) listener();
}

export function takeIntent(): SurfaceIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}

/** Called whenever an intent is requested; the listener takes it with `takeIntent()`. */
export function onIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The bot and chat an "open-bot" intent selects: the bot's most recent chat (`chats` newest
 * first), or its new chat. Null when the bot no longer exists.
 */
export function openBotSelection(
  intent: Extract<SurfaceIntent, { kind: "open-bot" }>,
  bots: readonly { id: string }[],
  chats: readonly { id: string }[],
): { botId: string; chatId: string | null } | null {
  if (!bots.some((bot) => bot.id === intent.botId)) return null;
  return { botId: intent.botId, chatId: intent.chat === "latest" ? (chats[0]?.id ?? null) : null };
}
