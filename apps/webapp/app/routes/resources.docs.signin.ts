import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { docsHintCookie, docsOrigin, isDocsOrigin } from "~/services/docsReader.server";
import { requireUserId } from "~/services/session.server";

/** "Sign in to see your own key" from the docs: log in (if needed), then go back to the docs page.
 * Only docs origins are allowed as the destination, so this is not an open redirect. */
export async function loader({ request }: LoaderFunctionArgs) {
  await requireUserId(request);

  const fallback = `${docsOrigin()}/docs`;
  const to = new URL(request.url).searchParams.get("to");
  let destination: URL | undefined;
  try {
    destination = to ? new URL(to) : undefined;
  } catch {}

  // This flow goes straight back to the docs without a dashboard page (whose root loader sets
  // the hint), so set it here for the docs page to find.
  const hint = docsHintCookie(request, true);
  return redirect(
    destination && isDocsOrigin(destination.origin) ? destination.toString() : fallback,
    hint ? { headers: { "Set-Cookie": hint } } : undefined
  );
}
