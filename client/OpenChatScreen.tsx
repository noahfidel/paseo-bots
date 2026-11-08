import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { BotsSurface } from "./BotsSurface";
import { requestIntent } from "./intent";
import { redirectAction } from "./open-chat";

/** Chats this client has already handed to Paseo's chat view, so going Back to the blank screen never opens the chat again. */
const opened = new Set<string>();

/** The browser's history on web; this project has no DOM types. */
const browserHistory = () => (Platform.OS === "web" ? (globalThis as { history?: { length: number; back(): void } }).history : undefined);

/** Whether the browser can step back past this screen. */
const canGoBack = () => (browserHistory()?.length ?? 0) > 1;

/**
 * Opened by "New chat with <Bot>" once the chat exists: hands it to Paseo's chat view and
 * shows nothing. Back from the chat lands here again; on web it steps back once more, so
 * Back passes over it. Without Paseo's navigation (older hosts), on native when shown
 * again, or if opening fails, it becomes the Bots screen with that chat selected.
 */
export function OpenChatScreen(props: PluginScreenProps) {
  const { params, navigation, host, theme } = props;
  const agentId = params.agentId ?? "";
  const botId = params.botId ?? "";
  const showBots = () => {
    if (botId) requestIntent({ kind: "new-chat", botId, ...(agentId ? { chatId: agentId } : {}) });
  };
  // Decided before the first render, so a Bots screen shown instead takes the intent as it mounts.
  const [action, setAction] = useState(() => {
    const next = redirectAction({ agentId, canNavigate: Boolean(navigation?.openAgent), alreadyOpened: opened.has(agentId), canGoBack: canGoBack() });
    if (next === "bots-screen") showBots();
    return next;
  });

  useEffect(() => {
    if (action === "bots-screen") return;
    try {
      if (action === "go-back") {
        browserHistory()!.back();
        return;
      }
      opened.add(agentId);
      navigation!.openAgent({ agentId, serverId: host.id });
    } catch {
      showBots();
      setAction("bots-screen");
    }
    // Runs once, for the screen's own params.
  }, []);

  if (action === "bots-screen") return <BotsSurface {...props} />;
  return <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }} />;
}
