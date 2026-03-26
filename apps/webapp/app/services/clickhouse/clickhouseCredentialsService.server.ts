import { getSecretStore } from "~/services/secrets/secretStore.server";
import { prisma } from "~/db.server";
import {
  ClickhouseConnectionSchema,
  getClickhouseSecretKey,
} from "./clickhouseSecretSchemas.server";
import { clearClickhouseCacheForOrganization } from "./clickhouseFactory.server";

export async function setOrganizationClickhouseUrl(
  organizationId: string,
  clientType: "standard" | "events" | "replication",
  url: string
): Promise<void> {
  // Validate URL format
  const connection = ClickhouseConnectionSchema.parse({ url });

  // Store in SecretStore
  const secretStore = getSecretStore("DATABASE");
  const secretKey = getClickhouseSecretKey(organizationId, clientType);
  await secretStore.setSecret(secretKey, connection);

  // Update featureFlags to reference the secret
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { featureFlags: true },
  });

  const featureFlags = (org?.featureFlags || {}) as any;
  const clickhouseConfig = featureFlags.clickhouse || {};
  clickhouseConfig[clientType] = secretKey;
  featureFlags.clickhouse = clickhouseConfig;

  await prisma.organization.update({
    where: { id: organizationId },
    data: { featureFlags },
  });

  // Clear cache
  clearClickhouseCacheForOrganization(organizationId);
}

export async function removeOrganizationClickhouseUrl(
  organizationId: string,
  clientType: "standard" | "events" | "replication"
): Promise<void> {
  // Remove from SecretStore
  const secretStore = getSecretStore("DATABASE");
  const secretKey = getClickhouseSecretKey(organizationId, clientType);
  await secretStore.deleteSecret(secretKey);

  // Update featureFlags
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { featureFlags: true },
  });

  if (org?.featureFlags) {
    const featureFlags = org.featureFlags as any;
    if (featureFlags.clickhouse && featureFlags.clickhouse[clientType]) {
      delete featureFlags.clickhouse[clientType];

      // If no more clickhouse configs, remove the clickhouse key entirely
      if (Object.keys(featureFlags.clickhouse).length === 0) {
        delete featureFlags.clickhouse;
      }

      await prisma.organization.update({
        where: { id: organizationId },
        data: { featureFlags },
      });
    }
  }

  // Clear cache
  clearClickhouseCacheForOrganization(organizationId);
}

export async function getOrganizationClickhouseUrl(
  organizationId: string,
  clientType: "standard" | "events" | "replication"
): Promise<string | null> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { featureFlags: true },
  });

  if (!org?.featureFlags) {
    return null;
  }

  const clickhouseConfig = (org.featureFlags as any).clickhouse;
  if (!clickhouseConfig || typeof clickhouseConfig !== "object") {
    return null;
  }

  const secretKey = clickhouseConfig[clientType];
  if (!secretKey || typeof secretKey !== "string") {
    return null;
  }

  const secretStore = getSecretStore("DATABASE");
  const connection = await secretStore.getSecret(ClickhouseConnectionSchema, secretKey);

  if (!connection) {
    return null;
  }

  return connection.url;
}
