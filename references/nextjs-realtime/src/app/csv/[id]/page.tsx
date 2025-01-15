import { notFound } from "next/navigation";
import RealtimeCSVRun from "./RealtimeCSVRun";

export default function CSVProcessor({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  if (typeof searchParams.publicAccessToken !== "string") {
    notFound();
  }

  return <RealtimeCSVRun runId={params.id} accessToken={searchParams.publicAccessToken} />;
}
