import type { TriggerClient } from "@trigger.dev/sdk";

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";

export function createSvelteRoute(client: TriggerClient) {
  const POST: RequestHandler = async ({ request }) => {
    	const response = await client.handleRequest(request);

      if (!response) {
        return json({ error: "Resource not found" }, { status: 404 });
      }

      return json(response.body, { status: response.status });
  };
  return { POST };
}
