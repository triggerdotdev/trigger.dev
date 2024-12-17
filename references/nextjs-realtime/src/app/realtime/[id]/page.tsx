import RunRealtimeComparison from "@/components/RunRealtimeComparison";
import { auth } from "@trigger.dev/sdk/v3";

export default async function RunRealtimeComparisonPage({ params }: { params: { id: string } }) {
  const accessToken = await auth.createPublicToken({
    scopes: {
      read: {
        runs: params.id,
      },
    },
  });

  return (
    <main className="flex min-h-screen items-center justify-center p-4 bg-gray-900">
      <RunRealtimeComparison accessToken={accessToken} runId={params.id} />
    </main>
  );
}
