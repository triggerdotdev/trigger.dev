import ClientAiDetails from "./ClientAiDetails";

export default async function DetailsPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { publicAccessToken: string };
}) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4 bg-gray-900">
      <ClientAiDetails runId={params.id} publicAccessToken={searchParams.publicAccessToken} />
    </main>
  );
}
