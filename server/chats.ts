import { opensChatsInPaseo, type Bot } from "../shared/bot";
import { startBotChat } from "../shared/chat";
import type { OpenChatResult } from "../shared/rpc";
import { newUuid } from "../shared/uuid";
import { ensureBotHome } from "./bot-home";
import type { BotsHost } from "./host";
import { systemPrompt } from "./prompt";
import type { Relay } from "./relay";

/**
 * Starts a chat for a bot on this host, the way the app does: its system
 * prompt, its folder, and the plugin's tools and connected apps. Routines and
 * requests from other bots start chats with it, and the Command Center starts
 * empty ones (no prompt): those get the bot's playbook list instead of picked playbooks.
 */
export async function startChat(host: BotsHost, relay: Relay, bot: Bot, input: { prompt?: string; title?: string; labels?: Record<string, string> }): Promise<string> {
  const paseo = host.requirePaseo();
  if (bot.hostId) throw new Error(`${bot.name} runs on another host, so its chats can't be started from here.`);
  const library = await host.library();
  const home = await ensureBotHome({ botId: bot.id });
  const values = await host.values();
  const { systemPrompt: system } = await systemPrompt(
    { bot, local: true, ...(input.prompt === undefined ? { indexPlaybooks: true } : { message: input.prompt }), ...(input.labels ? { labels: input.labels } : {}) },
    library,
    paseo,
    values,
  );
  const hideFromSidebar = await host.hideBotChats();
  const agentId = newUuid();
  return startBotChat(paseo, {
    bot,
    library,
    agentId,
    plugin: { tools: await relay.mountTools(bot.id, agentId), apps: bot.apps.length ? await relay.mountApps(bot.id) : null },
    hideFromSidebar,
    placement: bot.cwd ? { path: bot.cwd, projectRoot: null } : { path: home.path, projectRoot: home.root },
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    systemPrompt: system,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
  });
}

/**
 * "New chat with <Bot>" from the Command Center: starts the bot's chat with no
 * message for Paseo's own chat view. The Bots screen takes over, as before, when
 * the setting is off, the settings aren't ready, or the bot isn't one this host can
 * start (on another host, or gone); those are checked before anything can fail. A
 * chat that was tried and failed comes back as the Bots screen with the error.
 */
export async function openChat(host: BotsHost, relay: Relay, botId: string): Promise<OpenChatResult> {
  const values = await host.values().catch(() => null);
  if (!values || !opensChatsInPaseo(values)) return { kind: "bots-screen" };
  const bot = values.bots.find((entry) => entry.id === botId);
  if (!bot || bot.archived || bot.hostId) return { kind: "bots-screen" };
  try {
    return { kind: "chat", agentId: await startChat(host, relay, bot, {}) };
  } catch (error) {
    return { kind: "bots-screen", error: error instanceof Error ? error.message : String(error) };
  }
}
