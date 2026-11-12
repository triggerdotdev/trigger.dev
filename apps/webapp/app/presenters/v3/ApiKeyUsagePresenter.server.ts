import { type RuntimeEnvironment } from "@trigger.dev/database";
import { type ApiKeyScopeUsage, type HostRbacController } from "@trigger.dev/rbac";
import { type PrismaReplicaClient, $replica } from "~/db.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { rbac } from "~/services/rbac.server";
import { API_KEY_USAGE_WINDOW_DAYS, type ApiKeyUsageView } from "~/utils/apiKeyUsage";

type ApiKeyUsageReader = Pick<HostRbacController, "apiKeyScopeUsage">;

export class ApiKeyUsagePresenter {
  #prismaClient: PrismaReplicaClient;
  #rbac: ApiKeyUsageReader;

  constructor(
    prismaClient: PrismaReplicaClient = $replica,
    rbacController: ApiKeyUsageReader = rbac
  ) {
    this.#prismaClient = prismaClient;
    this.#rbac = rbacController;
  }

  public async call({
    userId,
    organizationSlug,
    projectSlug,
    environmentSlug,
    apiKeyId,
  }: {
    userId: User["id"];
    organizationSlug: string;
    projectSlug: Project["slug"];
    environmentSlug: RuntimeEnvironment["slug"];
    apiKeyId: string;
  }) {
    const environment = await this.#prismaClient.runtimeEnvironment.findFirst({
      select: { id: true, type: true, parentEnvironmentId: true, organizationId: true },
      where: {
        project: { slug: projectSlug, organization: { slug: organizationSlug } },
        organization: { slug: organizationSlug, members: { some: { userId } } },
        slug: environmentSlug,
        OR: [{ type: { not: "DEVELOPMENT" } }, { type: "DEVELOPMENT", orgMember: { userId } }],
      },
    });

    if (!environment) {
      throw new Error("Environment not found");
    }

    const apiKey = await this.#prismaClient.apiKey.findFirst({
      where: {
        id: apiKeyId,
        runtimeEnvironmentId: environment.parentEnvironmentId ?? environment.id,
        issuedBy: "USER",
      },
      select: { id: true, name: true, createdAt: true, scopes: true, revokedAt: true },
    });

    if (!apiKey) {
      return { environmentType: environment.type, apiKey: null, usage: null };
    }

    const usage = apiKey.revokedAt
      ? null
      : await this.#rbac.apiKeyScopeUsage({
          organizationId: environment.organizationId,
          windowDays: API_KEY_USAGE_WINDOW_DAYS,
          apiKeys: [{ id: apiKey.id, createdAt: apiKey.createdAt, scopes: apiKey.scopes }],
        });

    return {
      environmentType: environment.type,
      apiKey: { id: apiKey.id, name: apiKey.name, revokedAt: apiKey.revokedAt },
      usage: usageView(usage?.find((entry) => entry.apiKeyId === apiKey.id)),
    };
  }
}

function usageView(usage: ApiKeyScopeUsage | undefined): ApiKeyUsageView | null {
  if (!usage) return null;
  return {
    trackedSince: usage.trackedSince,
    windowDays: API_KEY_USAGE_WINDOW_DAYS,
    capabilities: usage.capabilities,
    narrowTo: usage.narrowTo,
    ...(usage.narrowBlocker ? { narrowBlocker: usage.narrowBlocker } : {}),
  };
}
