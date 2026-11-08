import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openBotChat, OPEN_CHAT_SCREEN_ID } from "../client/open-chat";
import { openBotSelection, takeIntent, type SurfaceIntent } from "../client/intent";
import { BOT_LABEL, opensChatsInPaseo, type Bot, type Playbook } from "../shared/bot";
import type { ChatApi } from "../shared/chat";
import { openChatRpc } from "../shared/rpc";
import { fakeHost, makeBot } from "./helpers";

const playbook = (name: string, triggers: string[], instructions = `${name} steps`): Playbook => ({ id: name, name, triggers, instructions });
const invoices = playbook("Invoices", ["invoice"]);

/** A Paseo with one Bots project and no workspaces yet, recording what each new chat was created with. */
function fakeApi() {
  const created: Record<string, unknown>[] = [];
  const workspaces: { background?: boolean }[] = [];
  const handle = (entry: Record<string, unknown>) => ({
    current: () => entry as never,
    refresh: async () => entry as never,
    setTitle: async () => undefined,
    archive: async () => undefined,
    agents: {
      create: async (options: Record<string, unknown>) => {
        created.push(options);
        return { id: (options.agentId as string | undefined) ?? "agent-1" };
      },
    },
  });
  const api: ChatApi & { config: { get(): Promise<never> } } = {
    projects: { list: async () => ({ projects: [{ projectId: "p1", projectRootPath: "/bots" }] as never }) },
    workspaces: {
      list: async () => ({ entries: [] }),
      ref: (workspace) => handle(workspace as never),
      open: async () => handle({}),
      create: async (options) => {
        workspaces.push({ background: options.background });
        return handle({ id: "w1", projectId: "p1", projectRootPath: "/bots", workspaceDirectory: options.source.path, title: options.title, background: options.background });
      },
    },
    providers: { snapshot: async () => ({ entries: [] }) },
    config: { get: async () => Promise.reject(new Error("no config")) },
  };
  return { api, created, workspaces };
}

const fakeRelay = { mountTools: async (botId: string, agentId: string) => ({ type: "http", url: `http://relay/bots/${botId}/${agentId}` }), mountApps: async () => null };

describe("the Command Center setting", () => {
  it("opens bot chats in Paseo's chat view unless it's turned off", () => {
    expect(opensChatsInPaseo({})).toBe(true);
    expect(opensChatsInPaseo({ openCommandChatsInPaseo: true })).toBe(true);
    expect(opensChatsInPaseo({ openCommandChatsInPaseo: false })).toBe(false);
  });

  it("has an RPC name the plugin installer accepts", () => {
    expect(openChatRpc.name).toMatch(/^[a-z][a-z0-9._-]*$/);
  });
});

describe("openChat on the server", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-open-chat-server-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  const setup = (bots: Bot[], patch: Record<string, unknown> = {}) => {
    const host = fakeHost(bots);
    const { api, created, workspaces } = fakeApi();
    host.attach(api as never);
    return { host, created, workspaces, patchValues: async () => Object.assign((await host.values()) as object, patch) };
  };

  it("starts the bot's chat with no message, labelled like a Bots-screen chat, in a hidden workspace when that's on", async () => {
    const { openChat } = await import("../server/chats");
    const { host, created, workspaces, patchValues } = setup([makeBot({ id: "inbox", model: "m", playbooks: [invoices] })], { hideBotChats: true });
    await patchValues();
    const result = await openChat(host, fakeRelay as never, "inbox");
    expect(result.kind).toBe("chat");
    const options = created[0]!;
    expect(result).toEqual({ kind: "chat", agentId: options.agentId });
    expect("prompt" in options).toBe(false);
    expect("title" in options).toBe(false);
    expect(options.labels).toEqual({ [BOT_LABEL]: "inbox" });
    expect(JSON.stringify(options.config)).toContain("get_playbook");
    expect(workspaces).toEqual([{ background: true }]);
  });

  it("leaves it to the Bots screen when the setting is off, the bot is on another host, or it's gone", async () => {
    const { openChat } = await import("../server/chats");
    const off = setup([makeBot({ id: "inbox", model: "m" })], { openCommandChatsInPaseo: false });
    await off.patchValues();
    expect(await openChat(off.host, fakeRelay as never, "inbox")).toEqual({ kind: "bots-screen" });
    const remote = setup([makeBot({ id: "inbox", model: "m", hostId: "other" })]);
    expect(await openChat(remote.host, fakeRelay as never, "inbox")).toEqual({ kind: "bots-screen" });
    expect(await openChat(remote.host, fakeRelay as never, "gone")).toEqual({ kind: "bots-screen" });
    expect(off.created).toEqual([]);
    expect(remote.created).toEqual([]);
  });
});

describe("New chat with <Bot> in the Command Center", () => {
  afterEach(() => {
    takeIntent();
  });

  const run = async (start: () => Promise<unknown>) => {
    const screens: unknown[] = [];
    const bots: SurfaceIntent[] = [];
    await openBotChat("inbox", { start: start as never, openScreen: (input) => screens.push(input), openBots: (intent) => bots.push(intent) });
    return { screens, bots };
  };

  it("opens the new chat through the redirect screen", async () => {
    const { screens, bots } = await run(async () => ({ kind: "chat", agentId: "agent-9" }));
    expect(screens).toEqual([{ screenId: OPEN_CHAT_SCREEN_ID, params: { agentId: "agent-9", botId: "inbox" } }]);
    expect(bots).toEqual([]);
  });

  it("opens the Bots screen as before when the server says so", async () => {
    const { screens, bots } = await run(async () => ({ kind: "bots-screen" }));
    expect(screens).toEqual([]);
    expect(bots).toEqual([{ kind: "new-chat", botId: "inbox" }]);
  });

  it("opens the Bots screen with the error when the chat couldn't start", async () => {
    const { bots } = await run(async () => Promise.reject(new Error("Paseo is offline")));
    expect(bots).toEqual([{ kind: "new-chat", botId: "inbox", error: "Paseo is offline" }]);
  });

  it("selects a chat that was already created when the Bots screen takes over", () => {
    expect(openBotSelection({ kind: "new-chat", botId: "bot-1", chatId: "agent-9" }, [{ id: "bot-1" }])).toEqual({ botId: "bot-1", chatId: "agent-9" });
  });
});
