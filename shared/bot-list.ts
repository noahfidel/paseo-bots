import { z } from "zod";
import type { Bot } from "./bot";

// What the app needs to list bots outside the Bots screen (the Command Center):
// names and titles only, never instructions, memory or credentials.

export const BotSummarySchema = z.object({ id: z.string(), name: z.string(), title: z.string(), archived: z.boolean() });
export type BotSummary = z.infer<typeof BotSummarySchema>;

/** `recentChats` is the "Recent chats in Command Center" setting as saved; missing means the default. */
export const BotListSchema = z.object({ bots: z.array(BotSummarySchema), recentChats: z.number().optional() });

export function botSummaries(values: { bots: readonly Pick<Bot, "id" | "name" | "title" | "archived">[] }): BotSummary[] {
  return values.bots.map(({ id, name, title, archived }) => ({ id, name, title, archived }));
}
