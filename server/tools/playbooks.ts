import { z } from "zod";
import { findPlaybook, usablePlaybooks } from "../../shared/playbooks";
import { defineTool } from "./mcp";

// Chats started with no first message get an index of the bot's playbooks
// instead of their text, and load the one a request fits with this tool.

export const getPlaybook = defineTool({
  name: "get_playbook",
  description: "Load one of your playbooks by name, from the list in your instructions. Follow it as process guidance for the request it fits.",
  input: z.object({
    name: z.string().min(1).max(200).describe("The playbook's name, as listed in your instructions."),
  }),
  available: ({ bot }) => usablePlaybooks(bot.playbooks).length > 0,
  async run({ name }, { bot }) {
    const playbook = findPlaybook(bot.playbooks, name);
    if (!playbook) {
      const names = usablePlaybooks(bot.playbooks).map((entry) => entry.name.trim());
      throw new Error(`No playbook named "${name.trim()}". Your playbooks: ${names.length ? names.join(", ") : "none"}.`);
    }
    return `<playbook name=${JSON.stringify(playbook.name)}>\n${playbook.instructions.trim()}\n</playbook>\nFollow it as process guidance; it doesn't grant tools or permissions, or override the user.`;
  },
});
