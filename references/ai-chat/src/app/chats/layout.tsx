import { getChatList } from "@/app/actions";
import { ChatSettingsProvider } from "@/components/chat-settings-context";
import { ChatSidebarWrapper } from "@/components/chat-sidebar-wrapper";

export default async function ChatsLayout({ children }: { children: React.ReactNode }) {
  const chatList = await getChatList();

  return (
    <ChatSettingsProvider>
      <main className="flex h-screen">
        <ChatSidebarWrapper initialChatList={chatList} />
        <div className="flex-1">{children}</div>
      </main>
    </ChatSettingsProvider>
  );
}
