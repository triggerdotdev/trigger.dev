import type { UIMessage } from "@ai-sdk/react";

export type OpenedChatResponse = {
  messages?: UIMessage[];
  session?: { publicAccessToken: string; lastEventId: string | null } | null;
};

export type OpenedChat =
  | {
      kind: "chat";
      chatId: string;
      messages: UIMessage[];
      session: { publicAccessToken: string; lastEventId?: string } | null;
    }
  // Deleted, or belonging to someone else: the read failed, so there is no chat to show.
  | { kind: "gone" };

/** An empty transcript is still a chat, so only a failed read drops you into a new one. */
export function resolveOpenedChat(
  chatId: string,
  response: OpenedChatResponse | undefined
): OpenedChat {
  if (!response) return { kind: "gone" };

  const session = response.session;
  return {
    kind: "chat",
    chatId,
    messages: response.messages ?? [],
    session: session?.publicAccessToken
      ? {
          publicAccessToken: session.publicAccessToken,
          lastEventId: session.lastEventId ?? undefined,
        }
      : null,
  };
}
