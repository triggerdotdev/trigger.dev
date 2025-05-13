import { notFound } from "next/navigation";
import ClientUploadDetails from "./ClientUploadDetails";

export default async function UploadPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const publicAccessToken = searchParams.publicAccessToken;

  if (typeof publicAccessToken !== "string") {
    notFound();
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4 bg-gray-900">
      <ClientUploadDetails fileId={params.id} publicAccessToken={publicAccessToken} />
    </main>
  );
}
