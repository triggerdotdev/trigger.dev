import { ChatContainer } from "@/components/chat-container";
import { Header } from "@/components/header";
import { auth } from "@trigger.dev/sdk";

export default async function Home() {
  const triggerToken = await auth.createTriggerPublicToken("todo-chat");

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="container mx-auto px-4 py-6">
        <ChatContainer triggerToken={triggerToken} />
      </main>
    </div>
  );
}
