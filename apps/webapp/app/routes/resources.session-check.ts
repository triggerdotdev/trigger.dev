import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { requireUserId } from "~/services/session.server";

// Authenticated probe for transports that can't read response headers
// (EventSource): requireUserId runs the SSO revalidation hook, so a revoked
// session returns the 401 + marker header that the client guard acts on.
export async function loader({ request }: LoaderFunctionArgs) {
  await requireUserId(request);
  return json({ ok: true });
}
