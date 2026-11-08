import { z } from "zod";
import type { Bot } from "./bot";

// What the app needs to list bots outside the Bots screen (the Command Center):
// names, titles and avatars only, never instructions, memory or credentials.

/** Optional so a client still parses the list from a daemon that predates avatars. */
const SummaryAvatarSchema = z.object({
  seed: z.string(),
  palette: z.number().int().nullable().default(null),
  shape: z.enum(["circle", "rounded", "square"]).default("circle"),
  imageUrl: z.string().nullable().default(null),
});

export const BotSummarySchema = z.object({ id: z.string(), name: z.string(), title: z.string(), archived: z.boolean(), avatar: SummaryAvatarSchema.optional() });
export type BotSummary = z.infer<typeof BotSummarySchema>;

export const BotListSchema = z.object({ bots: z.array(BotSummarySchema) });

export function botSummaries(values: { bots: readonly Pick<Bot, "id" | "name" | "title" | "archived" | "avatar">[] }): BotSummary[] {
  return values.bots.map(({ id, name, title, archived, avatar }) => ({ id, name, title, archived, avatar: { seed: avatar.seed, palette: avatar.palette, shape: avatar.shape, imageUrl: avatar.imageUrl } }));
}
