import type { ActionArgs } from "@remix-run/server-runtime";

export async function action({ request }: ActionArgs) {
  return { status: 200 };
}
