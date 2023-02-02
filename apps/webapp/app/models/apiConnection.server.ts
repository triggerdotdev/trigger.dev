import type { APIConnection, Organization } from ".prisma/client";
import { z } from "zod";
import { prisma } from "~/db.server";
import { Workflow } from "./workflow.server";

export { APIConnection };

export const apiKeyConfigSchema = z.object({
  api_key: z.string().min(1),
  additionalFields: z.record(z.string()).optional(),
});

export async function createAPIConnection({
  organizationId,
  title,
  apiIdentifier,
  scopes,
  authenticationMethod,
  authenticationConfig,
  type,
}: Pick<
  APIConnection,
  | "title"
  | "apiIdentifier"
  | "type"
  | "scopes"
  | "authenticationMethod"
  | "authenticationConfig"
> & {
  organizationId: Organization["id"];
}) {
  return await prisma.aPIConnection.create({
    data: {
      title,
      apiIdentifier,
      type,
      scopes,
      authenticationMethod,
      authenticationConfig: authenticationConfig ?? undefined,
      organization: {
        connect: {
          id: organizationId,
        },
      },
    },
  });
}

export async function setConnectedAPIConnection({
  id,
}: {
  id: APIConnection["id"];
}) {
  return await prisma.aPIConnection.update({
    where: {
      id,
    },
    data: {
      status: "CONNECTED",
    },
  });
}

export async function getConnectedApiConnectionsForOrganizationSlug({
  slug,
}: {
  slug: Organization["slug"];
}) {
  return await prisma.aPIConnection.findMany({
    where: {
      status: "CONNECTED",
      organization: {
        slug,
      },
    },
  });
}

export async function getApiConnectionsForOrganizationId({
  id,
}: {
  id: Organization["id"];
}) {
  return await prisma.aPIConnection.findMany({
    where: {
      organization: {
        id,
      },
    },
  });
}

export async function getApiConnectionById({
  id,
}: {
  id: APIConnection["id"];
}) {
  return await prisma.aPIConnection.findUnique({
    where: {
      id,
    },
  });
}

export async function updateApiConnectionTitle({
  id,
  title,
}: {
  id: APIConnection["id"];
  title: APIConnection["title"];
}) {
  return await prisma.aPIConnection.update({
    where: {
      id,
    },
    data: {
      title,
    },
  });
}

export async function getApiConnectionsForWorkflow({
  workflowId,
}: {
  workflowId: Workflow["id"];
}) {
  const workflow = await prisma.workflow.findUnique({
    where: {
      id: workflowId,
    },
    select: {
      externalSource: {
        select: {
          service: true,
          connection: true,
        },
      },
      externalServices: {
        select: {
          service: true,
          connection: true,
        },
      },
    },
  });

  if (!workflow) return [];

  let connections: APIConnection[] = [];
  if (workflow.externalSource?.connection) {
    connections.push(workflow.externalSource.connection);
  }
  workflow.externalServices.forEach((s) => {
    if (s.connection) {
      connections.push(s.connection);
    }
  });

  return connections;
}
