import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";
import type { OpenChatResult } from "../shared/rpc";
import type { SurfaceIntent } from "./intent";

// "New chat with <Bot>" from the Command Center. With the "Open ⌘K bot chats in Paseo's
// chat view" setting on, the daemon starts the chat with no message and the item opens a
// blank screen that hands it to Paseo's chat view: Command Center items can't open an
// agent themselves, but screens can. Anything else goes to the Bots screen, as before.

/** The blank screen that opens a chat in Paseo's chat view; params `agentId` and `botId`. */
export const OPEN_CHAT_SCREEN_ID = "open-chat";

/** How long the Command Center waits for the chat before opening the Bots screen instead. */
const START_TIMEOUT_MS = 5_000;

export interface OpenBotChatDeps {
  /** Starts the bot's chat for Paseo's chat view (the `bots.open-chat` RPC). */
  start(botId: string): Promise<OpenChatResult>;
  openScreen(input: PluginOpenScreenInput): void;
  /** Opens the Bots screen with the intent. */
  openBots(intent: Extract<SurfaceIntent, { kind: "new-chat" }>): void;
  /** Tests shorten it. */
  timeoutMs?: number;
}

/** Bots whose chat is being started, so pressing the item again doesn't start a second, empty one. */
const starting = new Map<string, Promise<void>>();

/**
 * The Bots screen opens, as before, when the setting is off, the RPC fails (an older daemon
 * build, a restart) or takes longer than five seconds; then a chat that arrives late doesn't
 * open too. The error shows only when the daemon tried to start the chat and failed.
 */
export function openBotChat(botId: string, deps: OpenBotChatDeps): Promise<void> {
  const current = starting.get(botId);
  if (current) return current;
  const run = startAndOpen(botId, deps).finally(() => starting.delete(botId));
  starting.set(botId, run);
  return run;
}

async function startAndOpen(botId: string, deps: OpenBotChatDeps): Promise<void> {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    deps.openBots({ kind: "new-chat", botId });
  }, deps.timeoutMs ?? START_TIMEOUT_MS);
  const started = deps.start(botId).then(
    (result) => {
      if (settled) return;
      settled = true;
      if (result.kind === "chat") deps.openScreen({ screenId: OPEN_CHAT_SCREEN_ID, params: { agentId: result.agentId, botId } });
      else deps.openBots({ kind: "new-chat", botId, ...(result.error ? { error: result.error } : {}) });
    },
    () => {
      if (settled) return;
      settled = true;
      deps.openBots({ kind: "new-chat", botId });
    },
  );
  // Waits for the chat even after the timeout, so the in-flight guard holds until it exists.
  await started;
  clearTimeout(timer);
}

export type RedirectAction = "open-agent" | "go-back" | "bots-screen";

/**
 * What the redirect screen does when it mounts: open the chat in Paseo's chat view the
 * first time; when shown again for that chat (Back from it), step back over itself where
 * it can (web), else show the Bots screen with the chat selected. Without Paseo's
 * navigation, or a chat, it shows the Bots screen.
 */
export function redirectAction({ agentId, canNavigate, alreadyOpened, canGoBack }: { agentId: string; canNavigate: boolean; alreadyOpened: boolean; canGoBack: boolean }): RedirectAction {
  if (!agentId || !canNavigate) return "bots-screen";
  if (!alreadyOpened) return "open-agent";
  return canGoBack ? "go-back" : "bots-screen";
}
