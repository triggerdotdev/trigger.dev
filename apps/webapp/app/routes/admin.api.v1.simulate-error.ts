import { withAdminApi } from "~/services/adminApi.server";
import { type DataFunctionArgs } from "@remix-run/node";
import { requireUser } from "~/services/session.server";

async function handleLoader({ request }: DataFunctionArgs) {
  const user = await requireUser(request);

  if (!user.admin) {
    throw new Response("You must be an admin to perform this action", { status: 403 });
  }

  throw new Error("Test error");
}

export const loader = withAdminApi(handleLoader);
