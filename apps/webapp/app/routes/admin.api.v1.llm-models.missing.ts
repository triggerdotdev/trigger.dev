import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { getMissingLlmModels } from "~/services/admin/missingLlmModels.server";

async function requireAdmin(request: Request) {
  const authResult = await authenticateApiRequestWithPersonalAccessToken(request);
  if (!authResult) {
    throw json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { id: authResult.userId } });
  if (!user?.admin) {
    throw json({ error: "You must be an admin to perform this action" }, { status: 403 });
  }

  return user;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdmin(request);

  const url = new URL(request.url);
  const lookbackHours = parseInt(url.searchParams.get("lookbackHours") ?? "24", 10);

  if (isNaN(lookbackHours) || lookbackHours < 1 || lookbackHours > 720) {
    return json({ error: "lookbackHours must be between 1 and 720" }, { status: 400 });
  }

  const models = await getMissingLlmModels({ lookbackHours });

  return json({ models, lookbackHours });
}
