import { useLoaderData } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { useEventSource } from "remix-utils";
import { z } from "zod";

export async function loader({ request }: LoaderArgs) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());

  const config = z
    .object({
      minDelay: z.coerce.number().int().min(0).max(10000).default(1000),
      maxDelay: z.coerce.number().int().min(0).max(10000).default(2000),
      undefinedProbability: z.coerce.number().min(0).max(1).default(0.1),
    })
    .parse(params);

  return config;
}

export default function SSETest() {
  const { minDelay, maxDelay, undefinedProbability } = useLoaderData<typeof loader>();

  const events = useEventSource(
    `/tests/sse/stream?minDelay=${minDelay}&maxDelay=${maxDelay}&undefinedProbability=${undefinedProbability}`,
    {
      event: "message",
    }
  );

  return (
    <div>
      <h2>SSE Test</h2>
      <p>{events ?? "No events"}</p>
    </div>
  );
}
