import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { runStreamLoader } from "~/presenters/v3/RunStreamPresenter.server";
import { requireUserId } from "~/services/session.server";

export async function loader(args: LoaderFunctionArgs) {
  // Authenticate the user before starting the stream
  await requireUserId(args.request);

  // Delegate to the SSE loader
  return runStreamLoader(args);
}
