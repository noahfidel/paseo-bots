import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { lastTurn, logLine } from "../shared/activity";
import type { BotsHost } from "./host";
import type { MemoryJournal } from "./journal";
import { appendDailyLog } from "./memory";
import type { RoutineScheduler } from "./scheduler";

// What happens around each turn of a bot's chat: the journal notes memory
// changes, and the daily log gets a line saying what the bot did.

export async function turnStarted(host: BotsHost, journal: MemoryJournal, { agent }: PluginLifecycleEvents["agent.turn_started"]): Promise<void> {
  const botId = await host.botIdOf(agent.id);
  if (botId) await journal.begin(botId);
}

/** Enough of the chat's tail to hold the turn that just ended (bots.ts reads chats the same way). */
const TURN_ITEMS = 80;

/**
 * The turn that just ended, read back from Paseo: the turn_ended event's own
 * timeline is always empty. Null when the chat couldn't be read.
 */
async function endedTurn(host: BotsHost, agentId: string): Promise<ReturnType<typeof lastTurn> | null> {
  try {
    const page = await host.requirePaseo().agents.ref(agentId).timeline.refetch({ direction: "tail", projection: "projected", limit: TURN_ITEMS });
    return lastTurn(page.entries.map((entry) => entry.item as { type: string; text?: unknown; name?: unknown }));
  } catch (error) {
    console.error("paseo-bots: couldn't read the turn that just ended", error);
    return null;
  }
}

export async function turnEnded(host: BotsHost, journal: MemoryJournal, scheduler: Pick<RoutineScheduler, "finished">, { agent, outcome }: PluginLifecycleEvents["agent.turn_ended"]): Promise<void> {
  const chat = await host.chatOf(agent.id);
  if (!chat) return;
  const { botId } = chat;
  const title = chat.title?.trim() || agent.title?.trim() || "Untitled chat";
  await journal.end(botId, { id: agent.id, title });
  const turn = await endedTurn(host, agent.id);
  if (chat.routineId) await scheduler.finished(chat.routineId, agent.id, outcome, turn?.reply ?? null, turn?.error ?? null);
  if (outcome.kind === "canceled") return;
  const line = logLine({ at: new Date(), chat: title, reply: turn?.reply ?? "", tools: turn?.tools ?? [], failure: outcome.kind === "failed" ? outcome.error.message : null });
  if (line) await appendDailyLog(botId, line);
}
