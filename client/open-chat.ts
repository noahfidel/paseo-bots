import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";
import type { OpenChatResult } from "../shared/rpc";
import type { SurfaceIntent } from "./intent";

// "New chat with <Bot>" from the Command Center. With the "Open ⌘K bot chats in Paseo's
// chat view" setting on, the daemon starts the chat with no message and the item opens a
// blank screen that hands it to Paseo's chat view: Command Center items can't open an
// agent themselves, but screens can. Anything else goes to the Bots screen, as before.

/** The blank screen that opens a chat in Paseo's chat view; params `agentId` and `botId`. */
export const OPEN_CHAT_SCREEN_ID = "open-chat";

export interface OpenBotChatDeps {
  /** Starts the bot's chat for Paseo's chat view (the `bots.open-chat` RPC). */
  start(botId: string): Promise<OpenChatResult>;
  openScreen(input: PluginOpenScreenInput): void;
  /** Opens the Bots screen with the intent. */
  openBots(intent: Extract<SurfaceIntent, { kind: "new-chat" }>): void;
}

export async function openBotChat(botId: string, deps: OpenBotChatDeps): Promise<void> {
  let result: OpenChatResult;
  try {
    result = await deps.start(botId);
  } catch (error) {
    deps.openBots({ kind: "new-chat", botId, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (result.kind === "bots-screen") deps.openBots({ kind: "new-chat", botId });
  else deps.openScreen({ screenId: OPEN_CHAT_SCREEN_ID, params: { agentId: result.agentId, botId } });
}
