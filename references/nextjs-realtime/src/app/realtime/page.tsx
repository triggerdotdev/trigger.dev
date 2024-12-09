import RealtimeComparison from "@/components/RealtimeComparison";
import { auth } from "@trigger.dev/sdk/v3";

export default async function RuntimeComparisonPage() {
  const accessToken = await auth.createTriggerPublicToken("openai-streaming");

  return (
    <main className="flex min-h-screen items-center justify-center p-4 bg-gray-900">
      <RealtimeComparison accessToken={accessToken} />
    </main>
  );
}
