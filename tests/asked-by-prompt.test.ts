import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_LIBRARY } from "../shared/bot";
import { ASKED_BY_LABEL, askState } from "../shared/bot-tools";
import { fakeHost, makeBot } from "./helpers";

const ASKED_SENTENCE = "You were asked by another bot, so you can't ask others; put anything another bot should do in your answer.";

/** A Paseo whose bot workspace already exists, recording what each new chat was created with. */
function fakePaseo() {
  const created: { config: { systemPrompt?: string }; labels?: Record<string, string> }[] = [];
  const workspace = { id: "w1", projectId: "p1", projectRootPath: "/bots", workspaceDirectory: "/bots/helper", title: "Helper" };
  const handle = {
    current: () => workspace,
    refresh: async () => workspace,
    setTitle: async () => undefined,
    archive: async () => undefined,
    agents: {
      create: async (options: (typeof created)[number]) => {
        created.push(options);
        return { id: "agent-1" };
      },
    },
  };
  const api = {
    projects: { list: async () => ({ projects: [workspace] }) },
    workspaces: { list: async () => ({ entries: [workspace] }), ref: () => handle, open: async () => handle, create: async () => handle },
    providers: { snapshot: async () => ({ entries: [] }) },
    config: { get: async () => ({ config: {} }) },
  };
  return { api, created };
}

const relay = { mountTools: async () => ({ type: "http", url: "http://127.0.0.1:1/bots/b/a", headers: {} }), mountApps: async () => null };

describe("a chat another bot asked", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-asked-by-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("follows the same rule as ask_bot's availability", () => {
    expect(askState("ask")).toBe("ask");
    expect(askState("allow", {})).toBe("ask");
    expect(askState("ask", { [ASKED_BY_LABEL]: "bot-asker" })).toBe("asked");
    expect(askState("off", { [ASKED_BY_LABEL]: "bot-asker" })).toBe("off");
  });

  it("gets a prompt without ask_bot that says why, and a plain chat keeps ask_bot", async () => {
    const { systemPrompt } = await import("../server/prompt");
    const bot = makeBot({ id: "bot-helper", name: "Helper" });
    const toolsOf = async (labels?: Record<string, string>) =>
      (await systemPrompt({ bot, local: true, message: "hi", ...(labels ? { labels } : {}) }, EMPTY_LIBRARY, null)).sections.find((section) => section.title === "Bot tools")?.text ?? "";

    const asked = await toolsOf({ [ASKED_BY_LABEL]: "bot-asker" });
    expect(asked).not.toContain("ask_bot");
    expect(asked).toContain(ASKED_SENTENCE);

    const plain = await toolsOf();
    expect(plain).toContain("ask_bot to ask one for help");
    expect(plain).not.toContain(ASKED_SENTENCE);
  });

  it("keeps today's wording when the bot can't contact others anyway", async () => {
    const { systemPrompt } = await import("../server/prompt");
    const bot = makeBot({ id: "bot-helper", contactBots: "off" });
    const { systemPrompt: text } = await systemPrompt({ bot, local: true, message: "hi", labels: { [ASKED_BY_LABEL]: "bot-asker" } }, EMPTY_LIBRARY, null);
    expect(text).not.toContain("ask_bot");
    expect(text).not.toContain(ASKED_SENTENCE);
    expect(text).toContain("and list_bots to see the other bots.");
  });

  it("is created with that prompt when ask_bot starts it", async () => {
    const { startChat } = await import("../server/chats");
    const bot = makeBot({ id: "bot-helper", name: "Helper", model: "m" });
    const host = fakeHost([bot]);
    const { api, created } = fakePaseo();
    host.attach(api as never);

    await startChat(host, relay as never, bot, { prompt: "question", title: "Asker: question", labels: { [ASKED_BY_LABEL]: "bot-asker" } });
    expect(created.at(-1)?.labels).toMatchObject({ [ASKED_BY_LABEL]: "bot-asker" });
    expect(created.at(-1)?.config.systemPrompt).not.toContain("ask_bot");
    expect(created.at(-1)?.config.systemPrompt).toContain(ASKED_SENTENCE);

    await startChat(host, relay as never, bot, { prompt: "question" });
    expect(created.at(-1)?.config.systemPrompt).toContain("ask_bot to ask one for help");
  });
});
