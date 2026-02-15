import { auth } from "@trigger.dev/sdk";
import { Chat } from "@/components/chat";

export default async function Home() {
  const accessToken = await auth.createTriggerPublicToken("ai-chat");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        <h1 className="mb-6 text-center text-2xl font-semibold">
          AI Chat <span className="text-gray-400">— powered by Trigger.dev</span>
        </h1>
        <Chat accessToken={accessToken} />
      </div>
    </main>
  );
}
