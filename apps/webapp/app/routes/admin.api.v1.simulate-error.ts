import { type DataFunctionArgs } from "@remix-run/node";
import { requireUser } from "~/services/session.server";

export async function loader({ request }: DataFunctionArgs) {
  const user = await requireUser(request);

  if (!user.admin) {
    throw new Response("You must be an admin to perform this action", { status: 403 });
  }

  throw new Error("Test error");
}
