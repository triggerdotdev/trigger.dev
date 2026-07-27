import { type RuntimeEnvironment } from "@trigger.dev/database";
import { scopesGrantFullAccess, type RoleBaseAccessController } from "@trigger.dev/rbac";
import { type PrismaReplicaClient, $replica } from "~/db.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { rbac } from "~/services/rbac.server";
import { obfuscateApiKey } from "~/utils/apiKeys";

type ApiKeyPolicyPresenter = Pick<
  RoleBaseAccessController,
  "apiKeyPresets" | "describeApiKeyPolicy"
>;

export class ApiKeysPresenter {
  // Read-only presenter for a dashboard page — all queries below are reads, so
  // default to the replica and keep this off the writer.
  #prismaClient: PrismaReplicaClient;
  #rbac: ApiKeyPolicyPresenter;

  constructor(
    prismaClient: PrismaReplicaClient = $replica,
    rbacController: ApiKeyPolicyPresenter = rbac
  ) {
    this.#prismaClient = prismaClient;
    this.#rbac = rbacController;
  }

  public async call({
    userId,
    organizationSlug,
    projectSlug,
    environmentSlug,
    showRevoked = false,
  }: {
    userId: User["id"];
    organizationSlug: string;
    projectSlug: Project["slug"];
    environmentSlug: RuntimeEnvironment["slug"];
    showRevoked?: boolean;
  }) {
    const environment = await this.#prismaClient.runtimeEnvironment.findFirst({
      select: {
        id: true,
        type: true,
        slug: true,
        branchName: true,
        parentEnvironmentId: true,
        taskIdentifiers: {
          where: { isInLatestDeployment: true },
          orderBy: { slug: "asc" },
          select: { slug: true },
        },
        project: { select: { id: true } },
        organizationId: true,
      },
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

    const keyEnvironmentId = environment.parentEnvironmentId ?? environment.id;

    const [keyEnvironment, vercelIntegration] = await Promise.all([
      this.#prismaClient.runtimeEnvironment.findUniqueOrThrow({
        where: { id: keyEnvironmentId },
        select: {
          id: true,
          apiKey: true,
          type: true,
          createdAt: true,
          apiKeys: {
            where: showRevoked ? undefined : { revokedAt: null },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              name: true,
              lastFour: true,
              presetId: true,
              scopes: true,
              lastUsedAt: true,
              revokedAt: true,
              expiresAt: true,
              createdAt: true,
              createdBy: {
                select: {
                  id: true,
                  email: true,
                  name: true,
                  displayName: true,
                },
              },
            },
          },
        },
      }),
      this.#prismaClient.organizationProjectIntegration.findFirst({
        where: {
          projectId: environment.project.id,
          deletedAt: null,
          organizationIntegration: { service: "VERCEL", deletedAt: null },
        },
        select: { id: true },
      }),
    ]);

    const [presets, policyDescriptions] = await Promise.all([
      this.#rbac.apiKeyPresets(environment.organizationId),
      Promise.all(
        keyEnvironment.apiKeys.map((apiKey) =>
          this.#rbac.describeApiKeyPolicy({
            presetId: apiKey.presetId,
            scopes: apiKey.scopes,
          })
        )
      ),
    ]);
    const presetsById = new Map(presets?.map((preset) => [preset.id, preset]));
    const { taskIdentifiers, organizationId: _organizationId, ...environmentData } = environment;

    return {
      environment: {
        ...environmentData,
        apiKey: keyEnvironment.apiKey,
        keyEnvironmentId,
      },
      availableTasks: taskIdentifiers.map((task) => task.slug),
      rootApiKey: {
        id: keyEnvironment.id,
        name: "Root API key",
        value: keyEnvironment.apiKey,
        obfuscated: obfuscateApiKey(keyEnvironment.type, keyEnvironment.apiKey.slice(-4)),
        createdAt: keyEnvironment.createdAt,
      },
      apiKeys: keyEnvironment.apiKeys.map((apiKey, index) => {
        const { presetId, scopes, ...apiKeyData } = apiKey;
        const description = policyDescriptions[index];
        const preset = presetId ? presetsById.get(presetId) : undefined;
        const isFullAccess = scopesGrantFullAccess(scopes);

        return {
          ...apiKeyData,
          access: {
            presetId,
            label: preset?.label ?? (presetId === null && isFullAccess ? "Full access" : "Custom"),
            taskIdentifiers: description.taskIdentifiers,
            usesTaskSelection:
              preset?.usesTaskSelection ?? description.taskIdentifiers !== undefined,
          },
          obfuscated: obfuscateApiKey(keyEnvironment.type, apiKey.lastFour, "additional"),
        };
      }),
      presets,
      hasVercelIntegration: vercelIntegration !== null,
    };
  }
}
