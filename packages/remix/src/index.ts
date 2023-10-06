import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import type { TriggerClient } from "@trigger.dev/sdk";

export function createRemixRoute(client: TriggerClient) {
  const action = async ({ request }: ActionFunctionArgs) => {
    const response = await client.handleRequest(request);

    if (!response) {
      return json({ error: "Not found" }, { status: 404 });
    }

    return json(response.body, { status: response.status, headers: response.headers });
  };
  return { action };
}
