import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { BotsSurface } from "./client/BotsSurface";
import { NativeConnectCard } from "./client/chat/stream/ConnectCard";
import { ProposalCard } from "./client/chat/stream/ProposalCard";
import { RoutineRunCard } from "./client/chat/stream/RoutineRunCard";
import { installAvatarRegistry } from "./client/avatar-registry";
import { installChatOpens } from "./client/chat-opens";
import { startBotItems } from "./client/bot-items";
import { requestIntent } from "./client/intent";
import { openBotChat, OPEN_CHAT_SCREEN_ID } from "./client/open-chat";
import { OpenChatScreen } from "./client/OpenChatScreen";
import { BotsSettings } from "./client/settings/BotsSettings";
import { installTooltips } from "./client/ui/Tooltip";
import { appSignIns } from "./shared/apps";
import { BOT_LABEL } from "./shared/bot";
import { proposalIdOf } from "./shared/proposals";
import { APP_SIGN_IN_CARD, AppSignInSchema, botListRpc, helloRpc, openChatRpc, ROUTINE_RUN_CARD, RoutineRunCardSchema } from "./shared/rpc";
import { LEARN_COMMAND, learnPrompt } from "./shared/skills";
import { schedulesAlertsRpc } from "./shared/schedules";
import { startScheduleAlerts } from "./client/schedules/alerts";
import { SchedulesScreen } from "./client/schedules/SchedulesScreen";
import { SCHEDULES_SCREEN_ID, SchedulesSidebarItem } from "./client/schedules/SchedulesSidebarItem";

export default function contribute(client: PluginClientContext) {
  // Hands the daemon side its Paseo API so bot routines can run.
  void client.rpc(helloRpc, {}).catch(() => {});
  const removeTooltips = installTooltips();
  client.addSurface("bots", BotsSurface);
  client.addSidebarItem({ id: "bots", title: "Bots", icon: "Bot", surface: "bots" });
  client.addSettingsScreen({ id: "bots", title: "Bots", icon: "Bot", Component: BotsSettings });
  // Schedules: bot routines, launchd jobs and Paseo schedules in one screen, opened with params, not intents.
  client.addScreen({ id: SCHEDULES_SCREEN_ID, title: "All schedules", Component: SchedulesScreen });
  client.addSidebarHeaderItem({ id: "schedules", title: "All schedules", Component: SchedulesSidebarItem });
  client.addCommandCenterItem({
    id: "open-schedules",
    title: "All schedules: Open",
    icon: "CalendarClock",
    keywords: ["schedule", "routine", "launchd", "cron", "job"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCHEDULES_SCREEN_ID });
    },
  });
  const stopScheduleAlerts = startScheduleAlerts(() => client.rpc(schedulesAlertsRpc, {}));
  client.addCommandCenterItem({
    id: "open-bots",
    title: "Open Bots",
    icon: "Bot",
    keywords: ["bot", "assistant", "persona"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("bots");
    },
  });
  client.addCommandCenterItem({
    id: "new-bot",
    title: "New bot",
    icon: "Plus",
    keywords: ["bot", "create", "assistant"],
    context: "global",
    onSelect({ openSurface }) {
      requestIntent({ kind: "new-bot" });
      openSurface("bots");
    },
  });
  // "New chat with <Bot>" for every unarchived bot.
  const stopBotItems = startBotItems({
    fetch: async () => (await client.rpc(botListRpc, {})).bots,
    intervalMs: 60_000,
    register: (item) =>
      client.addCommandCenterItem({
        id: item.id,
        title: item.title,
        icon: "Bot",
        keywords: item.keywords,
        context: "global",
        onSelect({ rpc, openScreen, openSurface }) {
          // Straight into Paseo's chat view when the setting is on; otherwise, or when that fails, the Bots screen.
          return openBotChat(item.intent.botId, {
            start: (botId) => rpc(openChatRpc, { botId }),
            openScreen,
            openBots: (intent) => {
              requestIntent(intent);
              openSurface("bots");
            },
          });
        },
      }),
  });
  // Bot avatars for other plugins (the workspace switcher), on globalThis.__paseoBotsAvatars; see docs/avatars-api.md.
  const stopAvatars = installAvatarRegistry({
    fetch: async () => (await client.rpc(botListRpc, {})).bots,
    intervalMs: 60_000,
  });
  // Chats the Bots screen shows, on globalThis.__paseoBotsChatOpens; see docs/chat-opens-api.md.
  installChatOpens();
  // The blank screen those items open to hand a new chat to Paseo's chat view. No sidebar item or Command Center entry.
  // Paseo rejects a screen with an empty title, which would stop everything registered after it.
  client.addScreen({ id: OPEN_CHAT_SCREEN_ID, title: "Opening chat", Component: OpenChatScreen });
  // Bot chats opened in Paseo's own agent view get the same /learn and skill cards.
  client.addSlashCommand({
    ...LEARN_COMMAND,
    context: "agent",
    async onSubmit({ agent, args, paseo }) {
      if (!agent.labels[BOT_LABEL]) throw new Error("/learn works in bot chats.");
      await paseo.agents.ref(agent.id).send(learnPrompt(args));
    },
  });
  client.addTimelineTransformer({
    id: "proposals",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const proposalId = proposalIdOf(item);
      return proposalId ? { items: [{ type: "plugin", kind: "proposal", version: 1, data: { proposalId } }] } : undefined;
    },
  });
  client.addTimelineRenderer({
    kind: "proposal",
    version: 1,
    schema: z.object({ proposalId: z.string() }),
    Component: ({ item, theme, layout }) => <ProposalCard colors={theme.colors} compact={layout.compact} proposalId={item.data.proposalId} />,
  });
  // A bot's request to connect an app, in Paseo's view too.
  client.addTimelineTransformer({
    id: "app-sign-ins",
    query: { itemType: "tool_call" },
    transform({ item }) {
      const signIns = appSignIns(item);
      return signIns.length ? { items: signIns.map((data) => ({ type: "plugin", ...APP_SIGN_IN_CARD, data })) } : undefined;
    },
  });
  client.addTimelineRenderer({
    ...APP_SIGN_IN_CARD,
    schema: AppSignInSchema,
    Component: ({ item, agentId, timestamp, theme }) => <NativeConnectCard colors={theme.colors} signIn={item.data} since={timestamp.getTime()} agentId={agentId} />,
  });
  // A routine's results chat opened in Paseo's view shows its run cards too (no navigation there).
  client.addTimelineRenderer({
    ...ROUTINE_RUN_CARD,
    schema: RoutineRunCardSchema,
    Component: ({ item, theme }) => <RoutineRunCard colors={theme.colors} card={item.data} />,
  });
  return () => {
    stopScheduleAlerts();
    stopBotItems();
    stopAvatars();
    removeTooltips();
  };
}
