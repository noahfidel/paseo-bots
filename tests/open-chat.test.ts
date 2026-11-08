import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { openBotChat, OPEN_CHAT_SCREEN_ID, redirectAction } from "../client/open-chat";
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

  it("reports a chat it tried and failed to start", async () => {
    const { openChat } = await import("../server/chats");
    const host = fakeHost([makeBot({ id: "inbox", model: "m" })]);
    // Paseo isn't attached, so starting the chat fails.
    const result = await openChat(host, fakeRelay as never, "inbox");
    expect(result).toEqual({ kind: "bots-screen", error: expect.stringContaining("isn't connected to Paseo") });
  });

  it("leaves it to the Bots screen when the setting is off, the bot is on another host, or it's gone", async () => {
    const { openChat } = await import("../server/chats");
    const off = setup([makeBot({ id: "inbox", model: "m" })], { openCommandChatsInPaseo: false });
    await off.patchValues();
    expect(await openChat(off.host, fakeRelay as never, "inbox")).toEqual({ kind: "bots-screen" });
    const remote = setup([makeBot({ id: "inbox", model: "m", hostId: "other" })]);
    expect(await openChat(remote.host, fakeRelay as never, "inbox")).toEqual({ kind: "bots-screen" });
    expect(await openChat(remote.host, fakeRelay as never, "gone")).toEqual({ kind: "bots-screen" });
    // Settings not ready, or the setting off before Paseo is attached: no error, just the Bots screen.
    const { BotsHost } = await import("../server/host");
    const loading = new BotsHost({ read: async () => ({ status: "loading" }) } as never);
    expect(await openChat(loading, fakeRelay as never, "inbox")).toEqual({ kind: "bots-screen" });
    const detached = fakeHost([makeBot({ id: "inbox", model: "m" })]);
    Object.assign((await detached.values()) as object, { openCommandChatsInPaseo: false });
    expect(await openChat(detached, fakeRelay as never, "inbox")).toEqual({ kind: "bots-screen" });
    expect(off.created).toEqual([]);
    expect(remote.created).toEqual([]);
  });
});

describe("New chat with <Bot> in the Command Center", () => {
  afterEach(() => {
    takeIntent();
    vi.useRealTimers();
  });

  const recorder = () => {
    const screens: unknown[] = [];
    const bots: SurfaceIntent[] = [];
    return { screens, bots, deps: (start: () => Promise<unknown>, timeoutMs?: number) => ({ start: start as never, openScreen: (input: unknown) => screens.push(input), openBots: (intent: SurfaceIntent) => bots.push(intent), ...(timeoutMs ? { timeoutMs } : {}) }) };
  };
  const run = async (start: () => Promise<unknown>) => {
    const record = recorder();
    await openBotChat("inbox", record.deps(start) as never);
    return record;
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

  it("shows the error only when the server tried and failed to start the chat", async () => {
    const { bots } = await run(async () => ({ kind: "bots-screen", error: "Paseo is offline" }));
    expect(bots).toEqual([{ kind: "new-chat", botId: "inbox", error: "Paseo is offline" }]);
  });

  it("opens the Bots screen without an error when the RPC itself fails", async () => {
    const { bots } = await run(async () => Promise.reject(new Error("Unknown RPC bots.open-chat")));
    expect(bots).toEqual([{ kind: "new-chat", botId: "inbox" }]);
  });

  it("opens the Bots screen after 5 seconds and ignores a chat that arrives later", async () => {
    vi.useFakeTimers();
    let finish: (value: unknown) => void = () => {};
    const record = recorder();
    const done = openBotChat("inbox", record.deps(() => new Promise((resolve) => (finish = resolve))) as never);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(record.bots).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(record.bots).toEqual([{ kind: "new-chat", botId: "inbox" }]);
    finish({ kind: "chat", agentId: "late" });
    await done;
    expect(record.screens).toEqual([]);
    expect(record.bots).toHaveLength(1);
  });

  it("doesn't start a second chat for a bot while one is being started", async () => {
    let finish: (value: unknown) => void = () => {};
    let starts = 0;
    const record = recorder();
    const start = () => {
      starts++;
      return new Promise((resolve) => (finish = resolve));
    };
    const first = openBotChat("inbox", record.deps(start) as never);
    const second = openBotChat("inbox", record.deps(start) as never);
    finish({ kind: "chat", agentId: "agent-1" });
    await Promise.all([first, second]);
    expect(starts).toBe(1);
    expect(record.screens).toHaveLength(1);
    // Once it's done, the next press starts a new chat.
    const third = openBotChat("inbox", record.deps(start) as never);
    finish({ kind: "chat", agentId: "agent-2" });
    await third;
    expect(starts).toBe(2);
  });

  it("selects a chat that was already created when the Bots screen takes over", () => {
    expect(openBotSelection({ kind: "new-chat", botId: "bot-1", chatId: "agent-9" }, [{ id: "bot-1" }])).toEqual({ botId: "bot-1", chatId: "agent-9" });
  });
});

describe("the redirect screen", () => {
  it("opens the chat once, then steps back over itself on web or shows the Bots screen", () => {
    const base = { agentId: "a", canNavigate: true, alreadyOpened: false, canGoBack: true };
    expect(redirectAction(base)).toBe("open-agent");
    expect(redirectAction({ ...base, alreadyOpened: true })).toBe("go-back");
    expect(redirectAction({ ...base, alreadyOpened: true, canGoBack: false })).toBe("bots-screen");
    expect(redirectAction({ ...base, canNavigate: false })).toBe("bots-screen");
    expect(redirectAction({ ...base, agentId: "" })).toBe("bots-screen");
  });
});
