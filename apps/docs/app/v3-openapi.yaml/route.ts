import { readFileSync } from "node:fs";
import path from "node:path";
import { contentDir } from "@/lib/content-files";

export const dynamic = "force-static";

// The REST API's OpenAPI description, at the URL it has always had.
export function GET() {
  return new Response(readFileSync(path.join(contentDir, "v3-openapi.yaml"), "utf8"), {
    headers: { "Content-Type": "text/yaml; charset=utf-8" },
  });
}
