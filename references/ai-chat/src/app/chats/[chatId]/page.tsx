import { getChatMessages, getSessionForChat, getChatList } from "@/app/actions";
import { ChatView } from "@/components/chat-view";
import { DEFAULT_MODEL } from "@/lib/models";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ chatId: string }>;
}) {
  const { chatId } = await params;

  const [messages, session, chatList] = await Promise.all([
    getChatMessages(chatId),
    getSessionForChat(chatId),
    getChatList(),
  ]);

  const chatMeta = chatList.find((c) => c.id === chatId);
  const isNewChat = !chatMeta;
  const model = chatMeta?.model ?? DEFAULT_MODEL;

  return (
    <ChatView
      chatId={chatId}
      initialMessages={messages}
      initialSession={session}
      isNewChat={isNewChat}
      model={model}
    />
  );
}
