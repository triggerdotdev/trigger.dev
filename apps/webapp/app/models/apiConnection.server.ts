import type { APIConnection, Organization } from ".prisma/client";
import { prisma } from "~/db.server";

export { APIConnection };

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
