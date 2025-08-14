import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type WhoAmIResponse } from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { v3ProjectPath } from "~/utils/pathBuilder";
import { authenticateRequest } from "~/services/apiAuth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const authenticationResult = await authenticateRequest(request, {
    personalAccessToken: true,
    organizationAccessToken: true,
    apiKey: false,
  });

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const url = new URL(request.url);
  const projectRef = url.searchParams.get("projectRef") ?? undefined;

  switch (authenticationResult.type) {
    case "personalAccessToken": {
      const result = await getIdentityFromPAT(authenticationResult.result.userId, projectRef);
      if (!result.success) {
        if (result.error === "user_not_found") {
          return json({ error: "User not found" }, { status: 404 });
        }

        return json({ error: result.error }, { status: 401 });
      }
      return json(result.result);
    }
    case "organizationAccessToken": {
      const result = await getIdentityFromOAT(
        authenticationResult.result.organizationId,
        projectRef
      );
      return json(result.result);
    }
    default: {
      authenticationResult satisfies never;
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }
  }
}

async function getIdentityFromPAT(
  userId: string,
  projectRef: string | undefined
): Promise<
  { success: true; result: WhoAmIResponse } | { success: false; error: "user_not_found" }
> {
  const user = await prisma.user.findFirst({
    select: {
      email: true,
    },
    where: {
      id: userId,
    },
  });

  if (!user) {
    return { success: false, error: "user_not_found" };
  }

  const userDetails = {
    userId,
    email: user.email,
    dashboardUrl: env.APP_ORIGIN,
  } satisfies WhoAmIResponse;

  if (!projectRef) {
    return {
      success: true,
      result: userDetails,
    };
  }

  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
    },
    where: {
      members: {
        some: {
          userId,
        },
      },
    },
  });

  if (orgs.length === 0) {
    return {
      success: true,
      result: userDetails,
    };
  }

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

  if (!project) {
    return {
      success: true,
      result: userDetails,
    };
  }

  const projectPath = v3ProjectPath({ slug: project.organization.slug }, { slug: project.slug });

  return {
    success: true,
    result: {
      ...userDetails,
      project: {
        url: new URL(projectPath, env.APP_ORIGIN).href,
        name: project.name,
        orgTitle: project.organization.title,
      },
    },
  };
}

async function getIdentityFromOAT(
  organizationId: string,
  projectRef: string | undefined
): Promise<{ success: true; result: WhoAmIResponse }> {
  // Organization auth tokens are currently only used internally for the build server.
  // We will eventually expose them in the application as well, as they are useful beyond the build server.
  // At that point we will need a v3 whoami endpoint that properly handles org auth tokens.
  // For now, we just return a dummy user id and email and keep using the existing v2 whoami endpoint.
  const orgDetails = {
    userId: `org_${organizationId}`,
    email: "not_applicable@trigger.dev",
    dashboardUrl: env.APP_ORIGIN,
  } satisfies WhoAmIResponse;

  if (!projectRef) {
    return {
      success: true,
      result: orgDetails,
    };
  }

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
      organizationId,
    },
  });

  if (!project) {
    return {
      success: true,
      result: orgDetails,
    };
  }

  const projectPath = v3ProjectPath({ slug: project.organization.slug }, { slug: project.slug });
  return {
    success: true,
    result: {
      ...orgDetails,
      project: {
        url: new URL(projectPath, env.APP_ORIGIN).href,
        name: project.name,
        orgTitle: project.organization.title,
      },
    },
  };
}
