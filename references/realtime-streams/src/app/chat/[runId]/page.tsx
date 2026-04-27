import { AIChat } from "@/components/ai-chat";
import Link from "next/link";

export default function ChatPage({
  params,
  searchParams,
}: {
  params: { runId: string };
  searchParams: { accessToken?: string };
}) {
  const { runId } = params;
  const accessToken = searchParams.accessToken;

  if (!accessToken) {
    return (
      <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20">
        <main className="flex flex-col gap-8 row-start-2 items-center">
          <h1 className="text-2xl font-bold text-red-600">Missing Access Token</h1>
          <p className="text-gray-600">This page requires an access token to view the stream.</p>
          <Link href="/" className="text-blue-600 hover:underline">
            Go back home
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="font-sans grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20">
      <main className="flex flex-col gap-8 row-start-2 items-start w-full max-w-4xl">
        <div className="flex items-center justify-between w-full">
          <h1 className="text-2xl font-bold">AI Chat Stream: {runId}</h1>
          <Link
            href="/"
            className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 transition-colors"
          >
            ← Back to Home
          </Link>
        </div>

        <div className="w-full bg-purple-50 p-4 rounded-lg">
          <p className="text-sm text-purple-900 mb-2">
            🤖 <strong>AI SDK v5:</strong> This stream uses AI SDK&apos;s streamText with
            toUIMessageStream()
          </p>
          <p className="text-xs text-purple-700">
            Try refreshing to test stream reconnection - it should resume where it left off.
          </p>
        </div>

        <div className="w-full border border-gray-200 rounded-lg p-6 bg-white">
          <AIChat accessToken={accessToken} runId={runId} />
        </div>
      </main>
    </div>
  );
}
