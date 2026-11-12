// The plugin's own tools, served to every local bot chat as the MCP server
// "bots": other bots, past chats, the setup, and proposals (skills, routines,
// setup changes, app connections) the user confirms in the chat.

export const TOOLS_MCP_NAME = "bots";

const BOT_TOOL_NAMES = ["list_bots", "ask_bot", "check_chat", "search_chats", "get_playbook", "get_setup", "propose_skill", "propose_routine", "propose_changes", "connect_app"] as const;
export type BotToolName = (typeof BOT_TOOL_NAMES)[number];

/**
 * Tools that only read or only propose something the user confirms, so they
 * run without a permission prompt. Asking another bot is left to the bot's
 * "Contact other bots" setting.
 */
export const QUIET_TOOLS: readonly BotToolName[] = ["list_bots", "check_chat", "search_chats", "get_playbook", "get_setup", "propose_skill", "propose_routine", "propose_changes", "connect_app"];

/**
 * The bot tool a timeline tool call is, whatever the provider calls it:
 * Claude `mcp__bots__ask_bot`, Codex `bots.ask_bot`, others `bots_ask_bot`.
 */
export function botToolName(name: string): BotToolName | null {
  const match = /^(?:mcp__)?bots(?:__|\.|_)([a-z_]+)$/.exec(name.trim());
  const tool = match?.[1];
  return tool && (BOT_TOOL_NAMES as readonly string[]).includes(tool) ? (tool as BotToolName) : null;
}

/** Providers that accept exact MCP tool grants (Paseo refuses the chat for others). */
export function supportsToolGrants(provider: string): boolean {
  return /^(claude|codex|opencode)(\b|$)/.test(provider);
}

/** Label on a chat started by another bot's ask_bot, carrying the asking bot's id. */
export const ASKED_BY_LABEL = "paseo-bots.asked-by";

/**
 * Whether a chat may ask other bots: "ask" when it gets ask_bot, "off" when the
 * bot's setting turns that off, "asked" when another bot started the chat
 * (bots answering another bot don't ask further, so requests can't loop).
 * Both the ask_bot tool and the system prompt go by this, so they agree.
 */
export function askState(contactBots: string, labels?: Record<string, string> | null): "ask" | "off" | "asked" {
  if (contactBots === "off") return "off";
  return labels?.[ASKED_BY_LABEL] ? "asked" : "ask";
}

/** The prompt section for the plugin's own tools, given to chats that get them (bots on the plugin's host). */
export function botToolsPrompt(ask: "ask" | "off" | "asked"): string {
  const others = ask === "ask" ? "list_bots to see the other bots and ask_bot to ask one for help (check_chat follows up)" : "list_bots to see the other bots";
  const asked = ask === "asked" ? " You were asked by another bot, so you can't ask others; put anything another bot should do in your answer." : "";
  return `Your own tools come from the MCP server "bots". Use propose_routine for your own recurring or webhook-started work (rather than Paseo schedules) and propose_skill to keep a way of working for next time. When the user asks you to set up or change bots, teams, skills, MCP servers or defaults, read get_setup and put all the changes in one propose_changes call. The user confirms proposals on a card in the chat. Use search_chats to look through your past chats and daily log, and ${others}.${asked}`;
}
