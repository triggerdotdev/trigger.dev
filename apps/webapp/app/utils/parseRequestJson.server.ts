import { Attributes } from "@opentelemetry/api";
import { startActiveSpan } from "~/v3/tracer.server";

export async function parseRequestJsonAsync(
  request: Request,
  attributes?: Attributes
): Promise<unknown> {
  return await startActiveSpan(
    "parseRequestJsonAsync()",
    async (span) => {
      span.setAttribute("content-length", parseInt(request.headers.get("content-length") ?? "0"));
      span.setAttribute("content-type", request.headers.get("content-type") ?? "application/json");
      span.setAttribute("experiment.async", false);

      const rawText = await startActiveSpan("request.text()", async () => {
        return await request.text();
      });

      if (rawText.length === 0) {
        return;
      }

      return JSON.parse(rawText);
    },
    {
      attributes,
    }
  );
}
