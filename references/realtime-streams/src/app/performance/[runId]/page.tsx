import { PerformanceMonitor } from "@/components/performance-monitor";
import Link from "next/link";

export default function PerformancePage({
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
    <div className="font-sans min-h-screen p-8 bg-gray-50">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Performance Monitor</h1>
            <p className="text-sm text-gray-600 mt-1">Run: {runId}</p>
          </div>
          <Link
            href="/"
            className="px-4 py-2 bg-white border border-gray-300 text-gray-800 rounded-lg hover:bg-gray-50 transition-colors"
          >
            ← Back to Home
          </Link>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <p className="text-sm text-blue-900">
            <strong>📊 Real-time Latency Monitoring:</strong> This page measures the time it takes
            for each chunk to travel from the task to your browser. Lower latency = better
            performance!
          </p>
        </div>

        <PerformanceMonitor accessToken={accessToken} runId={runId} />
      </div>
    </div>
  );
}
