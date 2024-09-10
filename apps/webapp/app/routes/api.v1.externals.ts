import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { alwaysExternal } from "@trigger.dev/core/v3/build";
import { apiCors } from "~/utils/apiCors";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return apiCors(request, json({}));
  }

  return apiCors(request, json({ externals: alwaysExternal }));
}
