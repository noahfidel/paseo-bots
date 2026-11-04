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

/** What a host older than 0.13.2 says when asked for background workspaces. */
const BACKGROUND_UNSUPPORTED = /background workspaces/i;

/**
 * Runs a Paseo call that can include background workspaces, asking for them
 * first and retrying without when the host is too old to know about them.
 * Hidden workspaces are Paseo's to hide from its sidebar, not from us: every
 * lookup must see them, or a bot would get a second workspace.
 */
export async function withBackground<T>(call: (includeBackground: boolean) => Promise<T>): Promise<T> {
  try {
    return await call(true);
  } catch (error) {
    if (!BACKGROUND_UNSUPPORTED.test(error instanceof Error ? error.message : String(error))) throw error;
    return call(false);
  }
}

/** Lists workspaces including background ones where the host supports them. */
export function listWorkspaces(api: ChatApi): Promise<{ entries: ChatWorkspace[]; backgroundSupported: boolean }> {
  return withBackground(async (includeBackground) => {
    const { entries } = await (includeBackground ? api.workspaces.list({ filter: { includeBackground: true } }) : api.workspaces.list());
    return { entries, backgroundSupported: includeBackground };
  });
}

/** Whether the host can keep workspaces out of Paseo's sidebar (Paseo 0.13.2 and later). */
export async function supportsBackgroundWorkspaces(api: ChatApi): Promise<boolean> {
  try {
    await api.workspaces.list({ filter: { includeBackground: true } });
    return true;
  } catch (error) {
    if (BACKGROUND_UNSUPPORTED.test(error instanceof Error ? error.message : String(error))) return false;
    throw error;
  }
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
  // Once every bot workspace is in the background the project list may not show the project, and opening the folder again would make a second root workspace.
  const { entries } = await listWorkspaces(api);
  const hidden = entries.find((workspace) => normalize(workspace.projectRootPath) === normalize(root));
  if (hidden) return hidden.projectId;
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
export async function ensureBotWorkspace(api: ChatApi, bot: Bot, placement: BotPlacement, hide = false) {
  const { entries, backgroundSupported } = await listWorkspaces(api);
  // A host without background workspaces has none to prefer, so the visible one is used as before.
  const wantBackground = hide && backgroundSupported;
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
  if (wantBackground) {
    try {
      return await api.workspaces.create({ title: bot.name, background: true, source });
    } catch (error) {
      // An older host still gets its chat, in a visible workspace.
      if (!BACKGROUND_UNSUPPORTED.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  return api.workspaces.create({ title: bot.name, source });
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
