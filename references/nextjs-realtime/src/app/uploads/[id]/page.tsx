import { notFound } from "next/navigation";
import ClientUploadDetails from "./ClientUploadDetails";

export default async function UploadPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const jwt = searchParams.jwt;

  if (typeof jwt !== "string") {
    notFound();
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4 bg-gray-100">
      <ClientUploadDetails fileId={params.id} jwt={jwt} />
    </main>
  );
}
