import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { ExportTraceServiceRequest, ExportTraceServiceResponse } from "@trigger.dev/otlp-importer";
import { otlpExporter } from "~/v3/otlpExporter.server";

export async function action({ request }: ActionFunctionArgs) {
  const contentType = request.headers.get("content-type");

  if (contentType === "application/json") {
    const body = await request.json();

    const exportResponse = await otlpExporter.exportTraces(body as ExportTraceServiceRequest);

    return json(exportResponse, { status: 200 })
  } else if (contentType === "application/x-protobuf") {
    const buffer = await request.arrayBuffer();

    const exportRequest = ExportTraceServiceRequest.decode(new Uint8Array(buffer));

    const exportResponse = await otlpExporter.exportTraces(exportRequest);

    return new Response(ExportTraceServiceResponse.encode(exportResponse).finish(), { status: 200 });
  } else {
    return new Response("Unsupported content type. Must be either application/x-protobuf or application/json", { status: 400 });
  }
}
