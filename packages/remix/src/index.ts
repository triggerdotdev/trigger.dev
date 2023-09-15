import type { ActionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import type { TriggerClient } from "@trigger.dev/sdk";

export function createRemixRoute(client: TriggerClient) {
  const action = async ({ request }: ActionArgs) => {
    const response = await client.handleRequest(request);

    if (!response) {
      return json({ error: "Not found" }, { status: 404 });
    }

    return json(response.body, { status: response.status });
  };
  return { action };
  
}
