import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  ExportMetricsServiceRequest,
  ExportMetricsServiceResponse,
} from "@trigger.dev/otlp-importer";
import { otlpExporter } from "~/v3/otlpExporter.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

    if (contentType.startsWith("application/json")) {
      const body = await request.json();

      const exportResponse = await otlpExporter.exportMetrics(
        body as ExportMetricsServiceRequest
      );

      return json(exportResponse, { status: 200 });
    } else if (contentType.startsWith("application/x-protobuf")) {
      const buffer = await request.arrayBuffer();

      const exportRequest = ExportMetricsServiceRequest.decode(new Uint8Array(buffer));

      const exportResponse = await otlpExporter.exportMetrics(exportRequest);

      return new Response(ExportMetricsServiceResponse.encode(exportResponse).finish(), {
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
