import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { GetOrgsResponseBody } from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const orgs = await prisma.organization.findMany({
    where: {
      deletedAt: null,
      members: {
        some: {
          userId: authenticationResult.userId,
        },
      },
    },
  });

  if (!orgs) {
    return json({ error: "Orgs not found" }, { status: 404 });
  }

  const result: GetOrgsResponseBody = orgs.map((org) => ({
    id: org.id,
    title: org.title,
    slug: org.slug,
    createdAt: org.createdAt,
  }));

  return json(result);
}
