import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";

/** The queues page became the Concurrency page; the bare old URL redirects with
 * its query intact. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  return redirect(`${url.pathname.replace(/\/queues$/, "/concurrency")}${url.search}`, 301);
};
