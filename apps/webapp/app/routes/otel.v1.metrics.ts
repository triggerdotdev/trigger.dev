import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import {
  ExportMetricsServiceRequest,
  ExportMetricsServiceResponse,
} from "@trigger.dev/otlp-importer";
import { otlpExporter, otlpTransformWorkerPoolEnabled } from "~/v3/otlpExporter.server";

export async function action({ request }: ActionFunctionArgs) {
  try {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

    if (contentType.startsWith("application/json")) {
      const exporter = await otlpExporter;
      const body = await request.json();

      const exportResponse = await exporter.exportMetrics(body as ExportMetricsServiceRequest);

      return json(exportResponse, { status: 200 });
    } else if (contentType.startsWith("application/x-protobuf")) {
      const exporter = await otlpExporter;
      const buffer = await request.arrayBuffer();

      if (otlpTransformWorkerPoolEnabled) {
        await exporter.exportMetricsRaw(new Uint8Array(buffer));

        return new Response(
          ExportMetricsServiceResponse.encode(ExportMetricsServiceResponse.create()).finish(),
          { status: 200 }
        );
      }

      const exportRequest = ExportMetricsServiceRequest.decode(new Uint8Array(buffer));

      const exportResponse = await exporter.exportMetrics(exportRequest);

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
