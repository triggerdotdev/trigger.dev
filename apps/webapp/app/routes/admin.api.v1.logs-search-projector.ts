import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { getLogsSearchProjector } from "~/services/logsSearchProjectorInstance.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdminApiRequest(request);
  return json(await getLogsSearchProjector().status());
}
