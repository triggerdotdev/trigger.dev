import { RunWithStreamsViewer } from "@/components/run-with-streams-viewer";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ accessToken: string }>;
};

export default async function RunWithStreamsPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { accessToken } = await searchParams;

  return (
    <div className="space-y-6">
      <div>
        <a href="/" className="text-blue-500 hover:text-blue-600 text-sm mb-4 inline-block">
          ← Back to Home
        </a>
        <h1 className="text-3xl font-bold mb-2">useRealtimeRunWithStreams Test</h1>
        <p className="text-gray-600">
          Monitoring a task run with multiple real-time streams
        </p>
      </div>

      <RunWithStreamsViewer runId={id} accessToken={accessToken} />
    </div>
  );
}

