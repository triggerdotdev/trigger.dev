import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { clearImpersonation } from "~/models/admin.server";

export async function action({ request }: ActionFunctionArgs) {
  return clearImpersonation(request, "/admin");
}
