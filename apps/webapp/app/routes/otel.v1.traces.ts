import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { ExportTraceServiceRequest, ExportTraceServiceResponse } from "@trigger.dev/otlp-importer";
import { otlpExporter } from "~/v3/otlpExporter.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

    if (contentType.startsWith("application/json")) {
      const body = await request.json();

      const exportResponse = await otlpExporter.exportTraces(body as ExportTraceServiceRequest);

      return json(exportResponse, { status: 200 });
    } else if (contentType.startsWith("application/x-protobuf")) {
      const buffer = await request.arrayBuffer();

      const exportRequest = ExportTraceServiceRequest.decode(new Uint8Array(buffer));

      const exportResponse = await otlpExporter.exportTraces(exportRequest);

      return new Response(ExportTraceServiceResponse.encode(exportResponse).finish(), {
        status: 200,
      });
    } else {
      return new Response(
        "Unsupported content type. Must be either application/x-protobuf or application/json",
        { status: 400 }
      );
    }
  } catch (error) {
    console.error(error);

    return new Response("Internal Server Error", { status: 500 });
  }
}
