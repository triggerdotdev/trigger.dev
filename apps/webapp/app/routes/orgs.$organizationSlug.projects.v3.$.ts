import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const organizationSlug = params.organizationSlug;
  const path = params["*"];

  const url = new URL(request.url);
  url.pathname = `/orgs/${organizationSlug}/projects/${path}`;

  return redirect(url.toString());
};
