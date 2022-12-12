import type { APIConnection, Organization } from ".prisma/client";
import { prisma } from "~/db.server";

export async function createAPIConnection({
  organizationId,
  title,
  apiIdentifier,
  scopes,
  type,
}: Pick<APIConnection, "title" | "apiIdentifier" | "type" | "scopes"> & {
  organizationId: Organization["id"];
}) {
  return await prisma.aPIConnection.create({
    data: {
      title,
      apiIdentifier,
      type,
      scopes,
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

export async function getApiConnectionsForOrganizationSlug({
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
