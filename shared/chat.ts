import type { WireAttachment } from "./attachments";
import { BOT_LABEL, buildAgentConfig, defaultModelId, type Bot, type Library, type PluginServers } from "./bot";

/** Label on chats started by a routine, carrying the routine id. */
export const ROUTINE_LABEL = "paseo-bots.routine";
/** Longest title Paseo accepts (protocol/agent-title-limits.ts). */
const MAX_TITLE_CHARS = 200;

/** Older chats were titled "[Bot Name] …"; places grouped by bot show them without the prefix. */
export function displayTitle(title: string | null | undefined): string {
  return (title ?? "").replace(/^\[[^\]]*\]\s*/, "") || "New chat";
}

/** Where a bot's chats live. */
export interface BotPlacement {
  /** The bot's own folder: its workspace's working folder. */
  path: string;
  /** Folder of the shared Bots project, or null when the bot has its own working folder. */
  projectRoot: string | null;
}

const normalize = (path: string | null | undefined) => (path ?? "").replace(/\/+$/, "");

// The part of Paseo's API these helpers use. Shared code may only import the plugin SDK's
// root, so the app and the server pass their Paseo API in, and it's checked against this.

interface ChatWorkspace {
  id?: string;
  projectId: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  title?: string | null;
  /** Set on workspaces Paseo keeps out of its sidebar (hosts from 0.13.2). */
  background?: boolean;
}

interface WorkspaceHandle {
  current(): ChatWorkspace | null;
  refresh(): Promise<ChatWorkspace | null>;
  setTitle(title: string): Promise<unknown>;
  archive(): Promise<unknown>;
  readonly agents: {
    create(options: {
      agentId?: string;
      config: ReturnType<typeof buildAgentConfig>;
      labels: Record<string, string>;
      prompt: string;
      title?: string;
      images?: { data: string; mimeType: string }[];
      attachments?: WireAttachment[];
      clientMessageId?: string;
    }): Promise<{ readonly id: string }>;
  };
}

export interface ChatApi {
  readonly projects: { list(): Promise<{ projects: ChatWorkspace[] }> };
  readonly workspaces: {
    list(options?: { filter?: { includeBackground?: boolean } }): Promise<{ entries: ChatWorkspace[] }>;
    ref(workspace: string | ChatWorkspace): WorkspaceHandle;
    open(path: string): Promise<WorkspaceHandle>;
    create(options: { title: string; background?: boolean; source: { kind: "directory"; path: string; projectId?: string } }): Promise<WorkspaceHandle>;
  };
  readonly providers: { snapshot(): Promise<{ entries: { provider: string; models?: { id: string; isDefault?: boolean; isSelectable?: boolean }[] }[] }> };
}

/** What the client says when the host hasn't reported background support: a host older than 0.13.2, or a connection that is still (re)connecting. */
const BACKGROUND_UNSUPPORTED = /background workspaces/i;
const isUnsupported = (error: unknown) => BACKGROUND_UNSUPPORTED.test(error instanceof Error ? error.message : String(error));

/** Hosts (by their API object) that have answered a background call, and hosts that stayed silent through the waits. */
const supportSeen = new WeakSet<object>();
const knownOld = new WeakSet<object>();

/** How long to wait between tries when the host says it has no background support, before believing it. Tests shorten it. */
export const backgroundProbe = { delays: [300, 600, 1200] };

/**
 * Runs a Paseo call that can include background workspaces, asking for them
 * first. The client reports "no background support" both on a host older than
 * 0.13.2 and while it is still connecting (it forgets the host's version on every
 * reconnect), so that answer is retried a few times before it is believed, and a
 * host that has already answered once is never treated as old. Only a host that
 * stays silent gets the plain call, so pass the API as `key` to remember what a
 * host has shown. Hidden workspaces are Paseo's to hide from its sidebar, not
 * from us: every lookup must see them, or a bot would get a second workspace.
 */
export async function withBackground<T>(call: (includeBackground: boolean) => Promise<T>, key?: object): Promise<T> {
  const delays = key && knownOld.has(key) ? [] : backgroundProbe.delays;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await call(true);
      if (key) {
        supportSeen.add(key);
        knownOld.delete(key);
      }
      return result;
    } catch (error) {
      if (!isUnsupported(error)) throw error;
      const delay = delays[attempt];
      if (delay === undefined) {
        if (key && supportSeen.has(key)) throw new Error("Paseo is reconnecting. Try again in a moment.");
        if (key) knownOld.add(key);
        return call(false);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Runs `task` until it works, waiting `delays` between tries (the last delay repeats), and
 * stops with no result once `stopped()` says so. For work that must outlive a reconnect.
 */
export async function retryUntil<T>(task: () => Promise<T>, stopped: () => boolean, delays: readonly number[]): Promise<T | undefined> {
  for (let attempt = 0; !stopped(); attempt++) {
    try {
      return await task();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delays[Math.min(attempt, delays.length - 1)] ?? 0));
    }
  }
  return undefined;
}

/** An agent filter that also matches chats in background workspaces, for hosts that support them. */
export function withBackgroundFilter<F extends object>(filter: F, includeBackground: boolean): F | (F & { includeBackground: true }) {
  return includeBackground ? { ...filter, includeBackground: true } : filter;
}

/** Lists workspaces including background ones where the host supports them. */
export function listWorkspaces(api: ChatApi): Promise<{ entries: ChatWorkspace[]; backgroundSupported: boolean }> {
  return withBackground(async (includeBackground) => {
    const { entries } = await (includeBackground ? api.workspaces.list({ filter: { includeBackground: true } }) : api.workspaces.list());
    return { entries, backgroundSupported: includeBackground };
  }, api);
}

/** Whether the host can keep workspaces out of Paseo's sidebar (Paseo 0.13.2 and later). */
export function supportsBackgroundWorkspaces(api: ChatApi): Promise<boolean> {
  return withBackground(async (includeBackground) => {
    if (includeBackground) await api.workspaces.list({ filter: { includeBackground: true } });
    return includeBackground;
  }, api);
}

/**
 * The Bots project: one Paseo project for the plugin, one workspace per bot.
 * Paseo registers a project the first time a folder is opened; that opening
 * also creates a workspace for the project folder itself, which is archived so
 * the project only lists bot workspaces.
 */
async function botsProjectId(api: ChatApi, root: string): Promise<string> {
  const { projects } = await api.projects.list();
  const existing = projects.find((project) => normalize(project.projectRootPath) === normalize(root));
  if (existing) return existing.projectId;
  const rootWorkspace = await api.workspaces.open(root);
  const snapshot = rootWorkspace.current() ?? (await rootWorkspace.refresh());
  if (!snapshot) throw new Error("Paseo didn't register the Bots project.");
  await rootWorkspace.archive().catch(() => undefined);
  return snapshot.projectId;
}

/** Whether a workspace is the bot's: same folder, and in a custom folder (which can hold other workspaces) named after the bot. */
function isBotWorkspace(workspace: ChatWorkspace, bot: Bot, placement: BotPlacement): boolean {
  return normalize(workspace.workspaceDirectory ?? workspace.projectRootPath) === normalize(placement.path) && (placement.projectRoot !== null || workspace.title === bot.name);
}

/**
 * Finds the bot's workspace (by its folder) or creates it, and keeps its title in step with the bot's name.
 *
 * With `hide` on, the bot's chats live in a background workspace, which Paseo leaves out of its sidebar.
 * A background workspace is preferred when one exists; a bot that only has a visible one (made before the
 * setting was on) gets a new background workspace, and the visible one is left as it is. With `hide` off a
 * visible workspace is preferred, but an existing background one is still used rather than duplicated.
 */
export function ensureBotWorkspace(api: ChatApi, bot: Bot, placement: BotPlacement, hide = false) {
  return serialized(bot.id, () => findOrCreateBotWorkspace(api, bot, placement, hide));
}

/** One lookup-and-create at a time per bot in this process, so two chats starting together can't each create a workspace. */
const botLocks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (botLocks.get(key) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => undefined);
  botLocks.set(key, tail);
  void tail.then(() => {
    if (botLocks.get(key) === tail) botLocks.delete(key);
  });
  return run;
}

async function findOrCreateBotWorkspace(api: ChatApi, bot: Bot, placement: BotPlacement, hide: boolean) {
  const { entries, backgroundSupported } = await listWorkspaces(api);
  if (hide && !backgroundSupported) {
    // Never fall back to a visible workspace here: this may be a reconnect, and a duplicate would split the bot's chats.
    throw new Error("Paseo on this host can't keep chats out of its sidebar: it needs Paseo 0.13.2 or later, or it's still connecting. Try again, or turn off \"Hide bot chats from Paseo's sidebar\" in the Bots settings.");
  }
  const wantBackground = hide;
  const matches = entries.filter((workspace) => isBotWorkspace(workspace, bot, placement));
  const background = matches.find((workspace) => workspace.background === true);
  const visible = matches.find((workspace) => workspace.background !== true);
  const mine = wantBackground ? background : (visible ?? background);
  if (mine) {
    const handle = api.workspaces.ref(mine);
    if (mine.title !== bot.name) await handle.setTitle(bot.name);
    return handle;
  }
  const projectId = placement.projectRoot ? await botsProjectId(api, placement.projectRoot) : undefined;
  const source = { kind: "directory" as const, path: placement.path, ...(projectId ? { projectId } : {}) };
  return api.workspaces.create({ title: bot.name, ...(wantBackground ? { background: true } : {}), source });
}

/** Renames the bot's workspaces after the bot is renamed; does nothing if there are none yet. */
export async function syncBotWorkspaceTitle(api: ChatApi, bot: Bot, placement: BotPlacement): Promise<void> {
  if (placement.projectRoot === null) return;
  const { entries } = await listWorkspaces(api);
  for (const workspace of entries) {
    if (normalize(workspace.workspaceDirectory ?? workspace.projectRootPath) === normalize(placement.path) && workspace.title !== bot.name) await api.workspaces.ref(workspace).setTitle(bot.name);
  }
}

export interface StartChatInput {
  bot: Bot;
  /** Resolves the bot's MCP servers. */
  library: Library;
  /** The chat's agent id, picked in advance so its tools URL can name it. */
  agentId?: string;
  /** The plugin's servers for this chat (tools, connected apps), from the relay on the bot's host. */
  plugin?: PluginServers;
  placement: BotPlacement;
  /** Keep the chat out of Paseo's sidebar (the "Hide bot chats from Paseo's sidebar" setting). */
  hideFromSidebar?: boolean;
  prompt: string;
  systemPrompt: string;
  /** Defaults to Paseo's own title derived from the prompt. */
  title?: string;
  labels?: Record<string, string>;
  images?: { data: string; mimeType: string }[];
  attachments?: WireAttachment[];
  clientMessageId?: string;
}

/**
 * Starts a chat (a thread in the bot's workspace) with the bot's configuration
 * and sends the first message. Used by the app and by the routine scheduler.
 */
export async function startBotChat(api: ChatApi, input: StartChatInput): Promise<string> {
  const { bot } = input;
  const model = bot.model ?? (await resolveDefaultModel(api, bot.provider));
  const workspace = await ensureBotWorkspace(api, bot, input.placement, input.hideFromSidebar === true);
  const agent = await workspace.agents.create({
    ...(input.agentId ? { agentId: input.agentId } : {}),
    config: buildAgentConfig(bot, input.library, model, input.systemPrompt, input.plugin),
    labels: { [BOT_LABEL]: bot.id, ...input.labels },
    prompt: input.prompt,
    ...(input.title ? { title: input.title.slice(0, MAX_TITLE_CHARS) } : {}),
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
  });
  return agent.id;
}

async function resolveDefaultModel(api: ChatApi, provider: string): Promise<string> {
  const snapshot = await api.providers.snapshot();
  const entry = snapshot.entries.find((candidate) => candidate.provider === provider);
  const model = defaultModelId(entry?.models ?? []);
  if (!model) throw new Error(`${provider} has no models available. Pick a model in the bot's settings.`);
  return model;
}
