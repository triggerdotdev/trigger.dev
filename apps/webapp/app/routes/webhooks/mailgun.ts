import type { ActionArgs } from "@remix-run/server-runtime";
import { mailgunClient } from "~/services/email.server";

export async function action({ request }: ActionArgs) {
  const data = await request.json();

  await mailgunClient.messages().send(data);

  return new Response(null, { status: 200 });
}
