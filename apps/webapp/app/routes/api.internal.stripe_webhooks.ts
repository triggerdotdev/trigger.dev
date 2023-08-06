import { ActionArgs } from "@remix-run/server-runtime";

/*
  To use this route, use the stripe CLI to forward events to this route:

  stripe listen --forward-to localhost:3030/api/internal/stripe_webhooks

  Then you can trigger events using the stripe CLI:

  stripe trigger price.created
*/
export async function action({ request }: ActionArgs) {
  const body: any = await request.json();

  const response = await fetch("https://jsonhero.io/api/create.json", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: body.type,
      content: body,
      readOnly: true,
    }),
  });

  const json: any = await response.json();

  console.log({ [body.type]: json.location });

  return json;
}
