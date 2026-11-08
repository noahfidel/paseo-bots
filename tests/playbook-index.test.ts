import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_LIBRARY, type Bot, type Playbook } from "../shared/bot";
import { startBotChat, type ChatApi } from "../shared/chat";
import { fakeHost, makeBot } from "./helpers";

const playbook = (name: string, triggers: string[], instructions = `${name} steps`): Playbook => ({ id: name, name, triggers, instructions });
const close = playbook("Month-end close", ["month end", "close the books"]);
const invoices = playbook("Invoices", ["invoice"]);
const empty = playbook("Draft", ["draft"], "  ");
const fakeRelay = { mountTools: async () => ({}), mountApps: async () => null };

/** A Paseo whose bot workspace already exists, recording what each new chat was created with. */
function fakeApi() {
  const created: Record<string, unknown>[] = [];
  const workspace = { id: "w1", projectId: "p1", projectRootPath: "/bots", workspaceDirectory: "/bots/inbox", title: "Inbox" };
  const handle = {
    current: () => workspace,
    refresh: async () => workspace,
    setTitle: async () => undefined,
    archive: async () => undefined,
    agents: {
      create: async (options: Record<string, unknown>) => {
        created.push(options);
        return { id: "agent-1" };
      },
    },
  };
  const api: ChatApi = {
    projects: { list: async () => ({ projects: [workspace] }) },
    workspaces: { list: async () => ({ entries: [workspace] }), ref: () => handle, open: async () => handle, create: async () => handle },
    providers: { snapshot: async () => ({ entries: [] }) },
  };
  return { api, created };
}

describe("chats started with no first message", () => {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-bots-open-chat-"));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });

  it("list the bot's playbooks and say to load the matching one with get_playbook", async () => {
    const { systemPrompt } = await import("../server/prompt");
    const bot = makeBot({ id: "pb-bot", playbooks: [close, invoices, empty] });
    const { systemPrompt: text, sections } = await systemPrompt({ bot, local: true, indexPlaybooks: true }, EMPTY_LIBRARY, null);
    const section = sections.find((entry) => entry.title === "Playbooks");
    expect(section?.text).toContain("get_playbook");
    expect(section?.text).toContain("- Month-end close: month end, close the books");
    expect(section?.text).toContain("- Invoices: invoice");
    // Only playbooks with instructions, and none of their bodies.
    expect(section?.text).not.toContain("Draft");
    expect(text).not.toContain("Invoices steps");
  });

  it("leave chats started with a message as they were", async () => {
    const { systemPrompt } = await import("../server/prompt");
    const bot = makeBot({ id: "pb-bot", playbooks: [close, invoices, empty] });
    const { sections } = await systemPrompt({ bot, local: true, message: "pay this invoice" }, EMPTY_LIBRARY, null);
    const section = sections.find((entry) => entry.title === "Playbooks");
    expect(section?.text).toContain('<playbook name="Invoices">\nInvoices steps\n</playbook>');
    expect(section?.text).not.toContain("get_playbook");
    // The Overview's preview (no message, no index asked for) gets no playbooks, as before.
    expect((await systemPrompt({ bot, local: true }, EMPTY_LIBRARY, null)).sections.map((entry) => entry.title)).not.toContain("Playbooks");
  });

  it("don't list playbooks for a bot on another host, which has no get_playbook", async () => {
    const { systemPrompt } = await import("../server/prompt");
    const bot = makeBot({ id: "pb-bot", playbooks: [invoices] });
    expect((await systemPrompt({ bot, local: false, indexPlaybooks: true }, EMPTY_LIBRARY, null)).sections.map((entry) => entry.title)).not.toContain("Playbooks");
  });

  it("are created in Paseo without a prompt", async () => {
    const { api, created } = fakeApi();
    const id = await startBotChat(api, { bot: makeBot({ model: "m" }), library: EMPTY_LIBRARY, placement: { path: "/bots/inbox", projectRoot: "/bots" }, systemPrompt: "s" });
    expect(id).toBe("agent-1");
    expect(created).toHaveLength(1);
    expect("prompt" in created[0]!).toBe(false);
  });
});

describe("get_playbook", () => {
  const run = async (bot: Bot, name: string) => {
    const { getPlaybook } = await import("../server/tools/playbooks");
    return getPlaybook.run({ name }, { bot, agentId: "a", host: fakeHost([bot]), relay: fakeRelay as never });
  };

  it("returns the calling chat's bot's playbook by name", async () => {
    const text = await run(makeBot({ playbooks: [close, invoices] }), "invoices");
    expect(text).toContain("Invoices steps");
    expect(text).not.toContain("Month-end close steps");
  });

  it("says which playbooks exist for an unknown name", async () => {
    await expect(run(makeBot({ playbooks: [close, invoices, empty] }), "Payroll")).rejects.toThrow(/No playbook named "Payroll".*Month-end close, Invoices/);
  });

  it("never returns another bot's playbook", async () => {
    await expect(run(makeBot({ id: "bot-b", playbooks: [close] }), "Invoices")).rejects.toThrow(/No playbook named "Invoices"/);
  });

  it("is offered only to bots that have playbooks", async () => {
    const { getPlaybook } = await import("../server/tools/playbooks");
    const caller = (bot: Bot) => ({ bot, agentId: "a", host: fakeHost([bot]), relay: fakeRelay as never });
    expect(await getPlaybook.available?.(caller(makeBot({ playbooks: [invoices] })))).toBe(true);
    expect(await getPlaybook.available?.(caller(makeBot({ playbooks: [empty] })))).toBe(false);
  });
});

