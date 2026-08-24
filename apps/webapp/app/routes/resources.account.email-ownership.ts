import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { getEmailOwnership } from "~/services/ssoManagedIdentity.server";
import { requireUser } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  return json({ ownership: await getEmailOwnership(user) });
}
