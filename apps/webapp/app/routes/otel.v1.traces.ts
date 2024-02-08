import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { ExportTraceServiceRequest, ExportTraceServiceResponse } from "@trigger.dev/otlp-importer";
import { otlpExporter } from "~/v3/otlpExporter.server";

export async function action({ request }: ActionFunctionArgs) {
  const buffer = await request.arrayBuffer();

  const exportRequest = ExportTraceServiceRequest.decode(new Uint8Array(buffer));

  const exportResponse = await otlpExporter.exportTraces(exportRequest);

  return new Response(ExportTraceServiceResponse.encode(exportResponse).finish(), { status: 200 });
}
