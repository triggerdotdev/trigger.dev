import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { WhoAmIResponse } from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { v3ProjectPath } from "~/utils/pathBuilder";

export async function loader({ request }: LoaderFunctionArgs) {
  logger.info("whoami v2", { url: request.url });
  try {
    const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);
    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      select: {
        email: true,
      },
      where: {
        id: authenticationResult.userId,
      },
    });

    if (!user) {
      return json({ error: "User not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const projectRef = url.searchParams.get("projectRef");

    let projectDetails: WhoAmIResponse["project"];

    if (projectRef) {
      const orgs = await prisma.organization.findMany({
        select: {
          id: true,
        },
        where: {
          members: {
            some: {
              userId: authenticationResult.userId,
            },
          },
        },
      });

      const project = await prisma.project.findFirst({
        select: {
          externalRef: true,
          name: true,
          slug: true,
          organization: {
            select: {
              slug: true,
              title: true,
            },
          },
        },
        where: {
          externalRef: projectRef,
          organizationId: {
            in: orgs.map((org) => org.id),
          },
        },
      });

      if (project) {
        const projectPath = v3ProjectPath(
          { slug: project.organization.slug },
          { slug: project.slug }
        );
        projectDetails = {
          url: new URL(projectPath, env.APP_ORIGIN).href,
          name: project.name,
          orgTitle: project.organization.title,
        };
      }
    }

    const result: WhoAmIResponse = {
      userId: authenticationResult.userId,
      email: user.email,
      dashboardUrl: env.APP_ORIGIN,
      project: projectDetails,
    };
    return json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Something went wrong";
    logger.error("Error in whoami v2", { error: errorMessage });
    return json({ error: errorMessage }, { status: 400 });
  }
}
