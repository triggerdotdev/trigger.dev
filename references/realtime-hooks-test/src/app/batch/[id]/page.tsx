import { BatchViewer } from "@/components/batch-viewer";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ accessToken: string }>;
};

export default async function BatchPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const { accessToken } = await searchParams;

  return (
    <div className="space-y-6">
      <div>
        <a href="/" className="text-blue-500 hover:text-blue-600 text-sm mb-4 inline-block">
          ← Back to Home
        </a>
        <h1 className="text-3xl font-bold mb-2">useRealtimeBatch Test</h1>
        <p className="text-gray-600">
          Monitoring all runs in a batch with real-time progress tracking
        </p>
      </div>

      <BatchViewer batchId={id} accessToken={accessToken} />
    </div>
  );
}

