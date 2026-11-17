import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { singleton } from "~/utils/singleton";
import { env } from "~/env.server";
import { runStore } from "~/v3/runStore.server";
import { environmentEncryption } from "../environmentEncryption/instance.server";
import { internalRunSigningService } from "../oidc/instance.server";
import { configuredPlaceholderKeyring } from "./placeholder.server";
import { SecretProxyService } from "./service.server";

const services = new WeakMap<PrismaClientOrTransaction, SecretProxyService>();

export function secretProxy(db: PrismaClientOrTransaction = prisma) {
  if (db === prisma) return singleton("secretProxy", () => createService(db));
  let service = services.get(db);
  if (!service) {
    service = createService(db);
    services.set(db, service);
  }
  return service;
}

function createService(db: PrismaClientOrTransaction) {
  return new SecretProxyService({
    db,
    encryption: environmentEncryption(db),
    enabled: env.SECRET_PROXY_ENABLED,
    keyring: configuredPlaceholderKeyring(
      env.SECRET_PROXY_ENABLED,
      env.SECRET_PROXY_PLACEHOLDER_KEYS
    ),
    serviceToken: env.SECRET_PROXY_SERVICE_TOKEN,
    issuer: env.RUN_TOKEN_ISSUER_URL,
    publicJwks: () => internalRunSigningService.getPublicJwks(),
    findRun: (id, runtimeEnvironmentId, projectId) =>
      runStore.findRunOnPrimary(
        { id, runtimeEnvironmentId, projectId },
        {
          select: {
            friendlyId: true,
            runtimeEnvironmentId: true,
            projectId: true,
            organizationId: true,
            attemptNumber: true,
            status: true,
            annotations: true,
          },
        }
      ),
  });
}
