import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { ExportLogsServiceRequest, ExportLogsServiceResponse } from "@trigger.dev/otlp-importer";
import { otlpExporter } from "~/v3/otlpExporter.server";

export async function action({ request }: ActionFunctionArgs) {
  const buffer = await request.arrayBuffer();

  const exportRequest = ExportLogsServiceRequest.decode(new Uint8Array(buffer));

  const exportResponse = await otlpExporter.exportLogs(exportRequest);

  return new Response(ExportLogsServiceResponse.encode(exportResponse).finish(), { status: 200 });
}
