import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { getMissingLlmModels } from "~/services/admin/missingLlmModels.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdminApiRequest(request);

  const url = new URL(request.url);
  const lookbackHours = parseInt(url.searchParams.get("lookbackHours") ?? "24", 10);

  if (isNaN(lookbackHours) || lookbackHours < 1 || lookbackHours > 720) {
    return json({ error: "lookbackHours must be between 1 and 720" }, { status: 400 });
  }

  const models = await getMissingLlmModels({ lookbackHours });

  return json({ models, lookbackHours });
}
