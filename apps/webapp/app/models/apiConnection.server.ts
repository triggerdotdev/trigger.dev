import type { APIConnection, Organization } from ".prisma/client";
import { prisma } from "~/db.server";
import { Pizzly } from "@nangohq/pizzly-node";
import { env } from "~/env.server";

export { APIConnection };

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

export async function getAccessToken({
  connectionId,
  apiIdentifier,
}: {
  connectionId: APIConnection["id"];
  apiIdentifier: APIConnection["apiIdentifier"];
}) {
  const pizzly = new Pizzly(env.PIZZLY_HOST);
  const accessToken = await pizzly.accessToken(apiIdentifier, connectionId);
  return accessToken;
}
