import type { LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";

export async function loader({ request }: LoaderArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const environmentWithUser = await prisma.runtimeEnvironment.findUnique({
    select: {
      orgMember: {
        select: {
          userId: true,
        }
      }
    },
    where: {
      id: authenticationResult.environment.id,
    }
  });

  const result = {
    ...authenticationResult.environment,
    userId: environmentWithUser?.orgMember?.userId,
  }

  return json(result);
}

