import { RunsWithTagViewer } from "@/components/runs-with-tag-viewer";

type PageProps = {
  params: Promise<{ tag: string }>;
  searchParams: Promise<{ accessToken: string }>;
};

export default async function RunsWithTagPage({ params, searchParams }: PageProps) {
  const { tag } = await params;
  const { accessToken } = await searchParams;

  return (
    <div className="space-y-6">
      <div>
        <a href="/" className="text-blue-500 hover:text-blue-600 text-sm mb-4 inline-block">
          ← Back to Home
        </a>
        <h1 className="text-3xl font-bold mb-2">useRealtimeRunsWithTag Test</h1>
        <p className="text-gray-600">
          Monitoring all runs with tag: <code className="bg-gray-100 px-2 py-1 rounded">{tag}</code>
        </p>
      </div>

      <RunsWithTagViewer tag={tag} accessToken={accessToken} />

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Tip:</strong> Trigger more tasks with this tag from the home page to see them appear here in real-time!
        </p>
      </div>
    </div>
  );
}

