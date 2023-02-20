import { EmitterWebhookEventName } from "@octokit/webhooks";
import { ActionArgs } from "@remix-run/server-runtime";
import { webhooks } from "~/services/github/githubApp.server";

export async function action({ request }: ActionArgs) {
  if (!webhooks) {
    return new Response("", { status: 200 });
  }

  const payload = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  const id = headers["x-github-delivery"];
  const name = headers["x-github-event"];
  const signature = headers["x-hub-signature"];

  await webhooks.verifyAndReceive({
    id,
    name: name as EmitterWebhookEventName,
    payload,
    signature,
  });

  return new Response("", { status: 200 });
}
