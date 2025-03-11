import { type LoaderFunctionArgs } from "@remix-run/server-runtime";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  throw new Response("Not found", { status: 404, statusText: "Select an environment" });
};
