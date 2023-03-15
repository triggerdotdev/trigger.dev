import type { ActionArgs } from "@remix-run/server-runtime";
import { verifyAndReceiveWebhook } from "~/features/ee/projects/github/githubApp.server";

export async function action({ request }: ActionArgs) {
  return verifyAndReceiveWebhook(request);
}
