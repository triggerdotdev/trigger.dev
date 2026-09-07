import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";

/** The queues page became the Concurrency page; old URLs (bookmarks, agent deep
 * links, the queue detail path) redirect with their sub-path and query intact. */
export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const subPath = params["*"] ? `/${params["*"]}` : "";
  const base = url.pathname.replace(/\/queues(\/.*)?$/, "/concurrency");
  return redirect(`${base}${subPath}${url.search}`, 301);
};
