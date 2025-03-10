import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  throw new Response("Not Implemented", { status: 501 });
};
