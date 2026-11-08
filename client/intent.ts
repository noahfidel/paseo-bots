// Command Center items can open the surface but can't pass it arguments.
// They leave an intent here, and the Bots screen they open takes it when it mounts.
// Paseo's openSurface always pushes a new Bots screen, even when one is open, and
// earlier ones can stay mounted under it, so only a mounting screen may take one.

/**
 * "new-chat" opens the bot's new chat, or `chatId` when the Command Center already started
 * one, and shows `error` when starting it failed.
 */
export type SurfaceIntent = { kind: "new-bot" } | { kind: "new-chat"; botId: string; chatId?: string; error?: string };

let pending: SurfaceIntent | null = null;

export function requestIntent(intent: SurfaceIntent): void {
  pending = intent;
}

export function takeIntent(): SurfaceIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}

/** What a Bots screen does with intents when it mounts: takes the pending one, if any. */
export function attachSurface(apply: (intent: SurfaceIntent) => void): void {
  const intent = takeIntent();
  if (intent) apply(intent);
}

/** The selection a "new-chat" intent opens: the chat it names, else the bot's new chat. Null when the bot no longer exists. */
export function openBotSelection(
  intent: Extract<SurfaceIntent, { kind: "new-chat" }>,
  bots: readonly { id: string }[],
): { botId: string; chatId: string | null } | null {
  return bots.some((bot) => bot.id === intent.botId) ? { botId: intent.botId, chatId: intent.chatId ?? null } : null;
}
