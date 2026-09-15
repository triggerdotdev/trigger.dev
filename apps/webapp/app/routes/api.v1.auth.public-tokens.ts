import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { handlePublicTokenRequest } from "~/services/publicTokens.server";

export async function action({ request }: ActionFunctionArgs) {
  return handlePublicTokenRequest(request);
}
