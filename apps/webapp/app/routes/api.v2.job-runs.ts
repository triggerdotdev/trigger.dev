import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/PATAuth.server";
import { generateErrorMessage } from "zod-error";
import { requireUserIdByPAT } from "~/services/session.server";
import { prisma } from "~/db.server";
import { JobRunsSchema } from "@trigger.dev/core";


export async function action({ request }: ActionArgs) {
   if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const authenticationResult = await authenticateApiRequest(request);
  
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Personal Access Token" }, { status: 401 });
  }
  const userId = await requireUserIdByPAT(authenticationResult);
  
  if (!userId) {
    return json({ error: "Invalid or Missing Personal Access Token" }, { status: 401 });
  }
  const anyBody = await request.json();

  const body = JobRunsSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ message: generateErrorMessage(body.error.issues) }, { status: 422 });
  }
  const { jobSlug, projectSlug, organizationSlug, status, environment } = body.data;

  const runs = await prisma.jobRun.findMany({
    select: {
      id: true,
      number: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      isTest: true,
      status: true,
      environment: {
        select: {
          type: true,
          slug: true,
          orgMember: {
            select: {
              userId: true,
            },
          },
        },
      },
      version: {
        select: {
          version: true,
        },
      },
    },
    where: {
      ...(status ? { status: status } : {}),
      job: {
        slug: jobSlug,
      },
      project: {
        slug: projectSlug,
      },
      organization: { slug: organizationSlug, members: { some: { userId } } },
      environment: {
        ...(environment ? { type: environment } : {}),
        OR: [
          {
            orgMember: null,
          },
          {
            orgMember: {
              userId,
            },
          },
        ],
      },
    },
    orderBy: [{ id: "desc" }],
  });

  return json({
    data: runs,
  });
}
