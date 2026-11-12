import { type RuntimeEnvironment } from "@trigger.dev/database";
import {
  type ApiKeyCapabilityCatalogue,
  type ApiKeyCapabilityDifference,
  type ApiKeyCapabilityMap,
  apiKeyCapabilityDifferences,
  apiKeyCapabilitiesForKey,
  CUSTOM_API_KEY_PRESET_ID,
} from "@trigger.dev/plugins";
import { scopesGrantFullAccess, type HostRbacController } from "@trigger.dev/rbac";
import { type PrismaReplicaClient, $replica } from "~/db.server";
import { type Project } from "~/models/project.server";
import { type User } from "~/models/user.server";
import { rbac } from "~/services/rbac.server";
import { obfuscateApiKey } from "~/utils/apiKeys";

type ApiKeyPolicyPresenter = Pick<
  HostRbacController,
  "apiKeyAccessOptions" | "describeApiKeyPolicy"
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
      this.#prismaClient.runtimeEnvironment.findFirstOrThrow({
        where: { id: keyEnvironmentId },
        select: {
          id: true,
          apiKey: true,
          rootApiKeyHiddenAt: true,
          type: true,
          apiKeys: {
            where: {
              revokedAt: showRevoked ? undefined : null,
              issuedBy: "USER",
            },
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              name: true,
              description: true,
              lastFour: true,
              presetId: true,
              scopes: true,
              lastUsedAt: true,
              lastUsedIp: true,
              allowedIpRanges: true,
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

    const [accessOptions, policyDescriptions] = await Promise.all([
      this.#rbac.apiKeyAccessOptions(environment.organizationId),
      Promise.all(
        keyEnvironment.apiKeys.map((apiKey) =>
          this.#rbac.describeApiKeyPolicy({
            presetId: apiKey.presetId,
            scopes: apiKey.scopes,
          })
        )
      ),
    ]);
    const presets = accessOptions?.presets ?? null;
    const capabilityCatalogue = accessOptions?.catalogue ?? null;
    const presetsById = new Map(presets?.map((preset) => [preset.id, preset]));
    const { taskIdentifiers, organizationId: _organizationId, ...environmentData } = environment;
    const isRootApiKeyHidden = keyEnvironment.rootApiKeyHiddenAt !== null;
    const rootApiKey = {
      id: keyEnvironment.id,
      name: "Root API key",
      value: isRootApiKeyHidden ? null : keyEnvironment.apiKey,
      obfuscated: obfuscateApiKey(keyEnvironment.type, keyEnvironment.apiKey.slice(-4)),
      isHidden: isRootApiKeyHidden,
    };

    return {
      environment: {
        ...environmentData,
        apiKey: rootApiKey.value,
        keyEnvironmentId,
      },
      availableTasks: taskIdentifiers.map((task) => task.slug),
      rootApiKey,
      apiKeys: keyEnvironment.apiKeys.map((apiKey, index) => {
        const { presetId, scopes, ...apiKeyData } = apiKey;
        const description = policyDescriptions[index];
        const preset = presetId ? presetsById.get(presetId) : undefined;
        const isFullAccess = scopesGrantFullAccess(scopes);
        const isCustom = !preset && !(presetId === null && isFullAccess);
        const differences = preset
          ? presetDifferences(
              capabilityCatalogue,
              preset,
              description.capabilities,
              description.taskIdentifiers
            )
          : [];
        const matchesPreset =
          preset !== undefined &&
          differences.length === 0 &&
          (description.unmatchedScopes?.length ?? 0) === 0;

        return {
          ...apiKeyData,
          access: {
            presetId,
            label: preset?.label ?? (isCustom ? "Custom" : "Full access"),
            isCustom,
            isOrganizationPreset: preset?.source === "organization",
            // A saved preset the key was made from has since been deleted.
            presetDeleted:
              presets !== null &&
              presetId !== null &&
              presetId !== CUSTOM_API_KEY_PRESET_ID &&
              preset === undefined,
            taskIdentifiers: description.taskIdentifiers,
            fullAccess: isFullAccess,
            capabilities: description.capabilities,
            unmatchedScopes: description.unmatchedScopes,
            usesTaskSelection:
              preset?.usesTaskSelection ?? description.taskIdentifiers !== undefined,
            drift: differences.filter((difference) => difference.gains),
            matchesPreset,
          },
          obfuscated: obfuscateApiKey(keyEnvironment.type, apiKey.lastFour, "additional"),
        };
      }),
      presets:
        presets?.map(({ scopes, ...preset }) => ({
          ...preset,
          fullAccess: scopesGrantFullAccess(scopes),
        })) ?? null,
      capabilityCatalogue,
      hasVercelIntegration: vercelIntegration !== null,
    };
  }
}

function presetDifferences(
  catalogue: ApiKeyCapabilityCatalogue | null,
  preset: { id: string; capabilities?: ApiKeyCapabilityMap },
  stored: ApiKeyCapabilityMap | undefined,
  taskIdentifiers: string[] | undefined
): ApiKeyCapabilityDifference[] {
  if (!catalogue || !stored || !preset.capabilities || preset.id === CUSTOM_API_KEY_PRESET_ID) {
    return [];
  }
  return apiKeyCapabilityDifferences(
    catalogue.capabilities,
    stored,
    apiKeyCapabilitiesForKey(catalogue.capabilities, preset.capabilities, taskIdentifiers)
  );
}
