import { ActionFunctionArgs } from "@remix-run/server-runtime";

export function action({ request }: ActionFunctionArgs) {
  return new Response(null, { status: 200 });
}
