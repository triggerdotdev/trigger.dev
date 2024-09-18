import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { clearImpersonation } from "~/models/admin.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  return clearImpersonation(request, "/admin");
}
