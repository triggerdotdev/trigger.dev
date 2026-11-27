import { type PrismaClientOrTransaction } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { singleton } from "~/utils/singleton";
import { env } from "~/env.server";
import { runStore } from "~/v3/runStore.server";
import { environmentEncryption } from "../environmentEncryption/instance.server";
import { internalRunSigningService } from "../oidc/instance.server";
import { configuredPlaceholderKeyring } from "./placeholder.server";
import { SecretProxyService } from "./service.server";
import type { ServiceCaller } from "../workloadIdentity.server";

/** The audience the relay's projected ServiceAccount token is minted for. */
const RELAY_AUDIENCE = "secret-proxy-resolver.trigger.dev";

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
    caller: relayCaller(),
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

function relayCaller(): ServiceCaller | undefined {
  if (env.WORKLOAD_IDENTITY_ISSUERS.length > 0) {
    return {
      kind: "workload",
      policy: {
        issuers: env.WORKLOAD_IDENTITY_ISSUERS,
        audience: RELAY_AUDIENCE,
        subject: env.SECRET_PROXY_RELAY_SUBJECT,
      },
    };
  }
  if (env.SECRET_PROXY_SERVICE_TOKEN) {
    return { kind: "sharedToken", token: env.SECRET_PROXY_SERVICE_TOKEN };
  }
}
