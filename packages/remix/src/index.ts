import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/node";
import type { TriggerClient } from "@trigger.dev/sdk";

export function createRemixAdapter(client: TriggerClient) {
  const Post = async ({ request }: ActionArgs) => {
    const response = await client.handleRequest(request);

    if (!response) {
      return json({ error: "Not found" }, { status: 404 });
    }

    return json(response.body, { status: response.status });
  };
}
