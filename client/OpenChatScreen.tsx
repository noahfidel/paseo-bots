import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { BotsSurface } from "./BotsSurface";
import { requestIntent } from "./intent";

/** Chats this client has already handed to Paseo's chat view, so going Back to the blank screen doesn't open the chat again. */
const opened = new Set<string>();

/**
 * Opened by "New chat with <Bot>" once the chat exists: hands it to Paseo's chat view and
 * shows nothing. Without Paseo's navigation (older hosts), or if opening fails, it becomes
 * the Bots screen with that chat selected.
 */
export function OpenChatScreen(props: PluginScreenProps) {
  const { params, navigation, host, theme } = props;
  const agentId = params.agentId ?? "";
  const botId = params.botId ?? "";
  const showBots = () => {
    if (botId) requestIntent({ kind: "new-chat", botId, ...(agentId ? { chatId: agentId } : {}) });
  };
  // Decided before the first render, so a Bots screen shown instead takes the intent as it mounts.
  const [fallback, setFallback] = useState(() => {
    if (agentId && navigation?.openAgent) return false;
    showBots();
    return true;
  });

  useEffect(() => {
    if (fallback || opened.has(agentId)) return;
    opened.add(agentId);
    try {
      navigation!.openAgent({ agentId, serverId: host.id });
    } catch {
      showBots();
      setFallback(true);
    }
    // Runs once, for the screen's own params.
  }, []);

  if (fallback) return <BotsSurface {...props} />;
  return <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }} />;
}
