export type NotifierOption = { key: string; label: string; disabled?: boolean };

export type EditableChannel = { id: string; name: string; type: string };

export type NotifierRef = { key: string; label: string };

export type ParsedNotifierRef =
  | { type: "channel"; channelId: string }
  | { type: "chat"; conversationId?: string; chatId?: string; userId?: string };

export function buildNotifierOptions(
  channels: EditableChannel[],
  currentNotifiers: NotifierRef[]
): NotifierOption[] {
  const enabledIds = new Set(channels.map((ch) => ch.id));
  const channelOptions: NotifierOption[] = channels.map((ch) => ({
    key: `channel:${ch.id}`,
    label: ch.name,
  }));
  for (const notifier of currentNotifiers) {
    if (!notifier.key.startsWith("channel:")) continue;
    const channelId = notifier.key.slice("channel:".length);
    if (!enabledIds.has(channelId)) {
      channelOptions.push({
        key: notifier.key,
        label: `${notifier.label} (disabled)`,
        disabled: true,
      });
    }
  }
  const chatNotifier = currentNotifiers.find((n) => n.key.startsWith("chat:"));
  const chatOption: NotifierOption | undefined = chatNotifier
    ? { key: chatNotifier.key, label: chatNotifier.label }
    : undefined;
  return chatOption ? [chatOption, ...channelOptions] : channelOptions;
}

export function parseNotifierKey(key: string): ParsedNotifierRef | null {
  if (key.startsWith("channel:")) {
    return { type: "channel", channelId: key.slice("channel:".length) };
  }
  if (key.startsWith("chat:")) {
    const parts = key.split(":");
    const raw1 = parts[1];
    const raw2 = parts[2];
    const conversationId = raw1 === "project" || !raw1 ? undefined : raw1;
    const userId = raw2 === "-" || !raw2 ? undefined : raw2;
    return {
      type: "chat",
      conversationId,
      chatId: conversationId,
      userId,
    };
  }
  return null;
}

export function validateChatRef(
  chat: Extract<ParsedNotifierRef, { type: "chat" }>,
  authenticatedUserId: string
): string | null {
  if (!chat.userId) return "Chat notifier must specify a user";
  if (chat.userId !== authenticatedUserId) return "Unauthorized chat notifier";
  return null;
}
