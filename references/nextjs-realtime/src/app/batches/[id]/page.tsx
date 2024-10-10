import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import ClientBatchRunDetails from "./ClientBatchRunDetails";

export default async function DetailsPage({ params }: { params: { id: string } }) {
  const cookieStore = cookies();
  const jwt = cookieStore.get("run_jwt");

  if (!jwt) {
    notFound();
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4 bg-gray-100">
      <ClientBatchRunDetails batchId={params.id} jwt={jwt.value} />
    </main>
  );
}
