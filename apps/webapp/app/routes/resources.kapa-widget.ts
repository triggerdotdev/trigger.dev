import { type LoaderFunctionArgs } from "@remix-run/node";

export async function loader({ request }: LoaderFunctionArgs) {
  const response = await fetch("https://widget.kapa.ai/kapa-widget.bundle.js");
  const script = await response.text();

  return new Response(script, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=86400", // Cache for 1 day
    },
  });
}
