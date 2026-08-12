import { isAdditionalApiKey } from "@trigger.dev/core/v3/apiKeys";
import { extractJWTSub, isPublicJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import { isDefaultDevBranch, sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import {
  scopesGrantFullAccess,
  type AuthenticatedEnvironment,
  type BearerAuthOptions,
  type BearerAuthResult,
} from "@trigger.dev/plugins";
import { createHash } from "node:crypto";
import { buildJwtAbility, permissiveAbility } from "./ability.js";

export type BearerCredentialClients = {
  // Used for the `lastUsedAt` telemetry write; reads go to the replica.
  primary: PrismaClient;
  replica: PrismaClient;
};

export type BearerCredentialKind =
  | "root_api_key"
  | "additional_api_key"
  | "public_jwt"
  | "legacy_public_key"
  | "unknown";

export type BearerLookupPath =
  | "plugin"
  | "root_current"
  | "root_rotated"
  | "additional"
  | "additional_skipped"
  | "jwt_current"
  | "jwt_rotated"
  | "legacy_public"
  | "not_found";

// Telemetry-only
export type BearerResolution = {
  credentialKind: BearerCredentialKind;
  lookupPath: BearerLookupPath;
};

export type BearerCredentialResult = BearerAuthResult & {
  resolution: BearerResolution;
};

// In the future if we remove the root env.apiKey for a dedicated JWT signing
// key, this is the only function that needs to change to resolve that
export function resolveJwtSigningKey(env: {
  apiKey: string;
  parentEnvironment?: { apiKey: string } | null;
}): string {
  return env.parentEnvironment?.apiKey ?? env.apiKey;
}

/**
 * Resolves an incoming bearer token into a `BearerAuthResult`: a public JWT, a
 * root environment API key, a grace-window rotated key, or an _sk_ additional key
 *
 * This is deliberately NOT part of the "no-plugin fallback". Additional API
 * keys are owned by the host, not by the optional RBAC plugin, so this
 * resolution is always-on and is composed by *both* the fallback controller
 * and the plugin-backed controller (which delegates host-owned keys here).
 *
 * Public JWTs carry inline scopes, which are compiled into an ability here.
 * Additional API-key credentials carry DB-persisted effective scopes, which
 * are compiled into their final ability here without a plugin policy lookup.
 */
export class BearerCredentialResolver {
  private readonly prisma: PrismaClient;
  private readonly replica: PrismaClient;

  constructor(
    clients: BearerCredentialClients,
    private readonly additionalApiKeyLookupEnabled: () => boolean = () => true
  ) {
    this.prisma = clients.primary;
    this.replica = clients.replica;
  }

  async authenticate(
    request: Request,
    options?: BearerAuthOptions
  ): Promise<BearerCredentialResult> {
    // Deprecated public API keys (`pk_*` minted long before public JWTs
    // landed) are intentionally NOT handled here. That token format hasn't
    // been issued for years; any `pk_*` bearer on an apiBuilder route returns
    // 401. Public access goes through the JWT path (`isPublicJWT`) instead.
    const rawToken = request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim();
    if (!rawToken) {
      return {
        ok: false,
        status: 401,
        error: "Invalid or Missing API key",
        resolution: { credentialKind: "unknown", lookupPath: "not_found" },
      };
    }

    if (options?.allowJWT && isPublicJWT(rawToken)) {
      const envId = extractJWTSub(rawToken);
      if (!envId) {
        return {
          ok: false,
          status: 401,
          error: "Invalid Public Access Token",
          resolution: { credentialKind: "public_jwt", lookupPath: "not_found" },
        };
      }

      // Match the include shape of the slim AuthenticatedEnvironment so
      // the bridge can use the returned env without a follow-up fetch.
      const env = await this.replica.runtimeEnvironment.findFirst({
        where: { id: envId },
        include: {
          project: true,
          organization: true,
          orgMember: {
            select: {
              userId: true,
              user: { select: { id: true, displayName: true, name: true } },
            },
          },
          parentEnvironment: {
            select: { id: true, apiKey: true },
          },
        },
      });
      if (!env || env.project.deletedAt !== null) {
        return {
          ok: false,
          status: 401,
          error: "Invalid Public Access Token",
          resolution: { credentialKind: "public_jwt", lookupPath: "not_found" },
        };
      }

      let lookupPath: BearerLookupPath = "jwt_current";
      let result = await validateJWT(rawToken, resolveJwtSigningKey(env));

      // Root-key rotation grace window, mirroring the bearer path below: a
      // rotated key keeps authenticating until its `RevokedApiKey` row expires,
      // so tokens *signed* with that key have to keep verifying for just as
      // long. Otherwise rotating a root key silently invalidates every
      // outstanding public access token in the environment.
      //
      // Only retried on a signature mismatch — an expired or malformed token
      // fails for a reason no other signing key can fix, and this runs on every
      // rejected public token.
      if (!result.ok && result.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
        // `resolveJwtSigningKey` signs a branch with its parent's key, so the
        // grace-window rows to consult belong to whichever env owns that key.
        const signingEnvironmentId = env.parentEnvironment?.id ?? env.id;
        const revoked = await this.replica.revokedApiKey.findMany({
          where: {
            runtimeEnvironmentId: signingEnvironmentId,
            expiresAt: { gt: new Date() },
          },
          select: { apiKey: true },
        });

        if (revoked.length > 0) lookupPath = "jwt_rotated";

        for (const candidate of revoked) {
          const retried = await validateJWT(rawToken, candidate.apiKey);
          if (retried.ok) {
            result = retried;
            break;
          }
        }
      }

      if (!result.ok) {
        return {
          ok: false,
          status: 401,
          error: "Public Access Token is invalid",
          resolution: { credentialKind: "public_jwt", lookupPath },
        };
      }

      const scopes = Array.isArray(result.payload.scopes)
        ? (result.payload.scopes as string[])
        : [];
      const realtime = result.payload.realtime as { skipColumns?: string[] } | undefined;
      const oneTimeUse = result.payload.otu === true;
      // A JWT minted from a PAT/UAT exchange stamps `act: { sub: userId }` for
      // attribution. Surface it so write handlers can record the acting user.
      const act = result.payload.act as { sub?: unknown } | undefined;
      const actSub = typeof act?.sub === "string" ? act.sub : undefined;

      return {
        ok: true,
        environment: toAuthenticatedEnvironment(env),
        subject: {
          type: "publicJWT",
          environmentId: env.id,
          organizationId: env.organizationId,
          projectId: env.projectId,
        },
        ability: buildJwtAbility(scopes),
        jwt: { realtime, oneTimeUse, ...(actSub ? { act: { sub: actSub } } : {}) },
        resolution: { credentialKind: "public_jwt", lookupPath },
      };
    }

    const branchName = sanitizeBranchName(request.headers.get("x-trigger-branch"));

    if (isAdditionalApiKey(rawToken)) {
      if (!this.additionalApiKeyLookupEnabled()) {
        return {
          ok: false,
          status: 401,
          error: "Invalid API key",
          resolution: {
            credentialKind: "additional_api_key",
            lookupPath: "additional_skipped",
          },
        };
      }

      return this.resolveAdditionalKey(rawToken, branchName, options?.allowPreviewParent);
    }

    return this.resolveRootKey(rawToken, branchName, options?.allowPreviewParent);
  }

  private async resolveRootKey(
    rawToken: string,
    branchName: string | null,
    allowPreviewParent = false
  ): Promise<BearerCredentialResult> {
    const include = environmentInclude(branchName);
    const now = new Date();
    let env = await this.replica.runtimeEnvironment.findFirst({
      where: { apiKey: rawToken },
      include,
    });

    let lookupPath: BearerLookupPath = "root_current";

    // Recently rotated root keys keep working until their grace period expires.
    if (!env) {
      const revoked = await this.replica.revokedApiKey.findFirst({
        where: {
          apiKey: rawToken,
          expiresAt: { gt: now },
        },
        include: { runtimeEnvironment: { include } },
      });
      env = revoked?.runtimeEnvironment ?? null;
      lookupPath = env ? "root_rotated" : "not_found";
    }

    const resolution: BearerResolution = {
      credentialKind: "root_api_key",
      lookupPath,
    };

    if (!env || env.project.deletedAt !== null) {
      return {
        ok: false,
        status: 401,
        error: "Invalid API key",
        resolution: {
          credentialKind: "root_api_key",
          lookupPath: "not_found",
        },
      };
    }

    const [branchError, resolvedEnvironment] = resolveBranch(env, branchName, allowPreviewParent);
    if (branchError !== null) {
      return {
        ok: false,
        status: 401,
        error: branchError,
        resolution,
      };
    }

    return {
      ok: true,
      environment: toAuthenticatedEnvironment(resolvedEnvironment),
      subject: {
        type: "user",
        userId: resolvedEnvironment.orgMember?.userId ?? "",
        organizationId: resolvedEnvironment.organizationId,
        projectId: resolvedEnvironment.projectId,
      },
      ability: permissiveAbility,
      resolution,
    };
  }

  private async resolveAdditionalKey(
    rawToken: string,
    branchName: string | null,
    allowPreviewParent = false
  ): Promise<BearerCredentialResult> {
    const resolution: BearerResolution = {
      credentialKind: "additional_api_key",
      lookupPath: "additional",
    };
    const now = new Date();
    const match = await this.replica.apiKey.findFirst({
      where: {
        keyHash: createHash("sha256").update(rawToken, "utf8").digest("hex"),
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: {
        id: true,
        lastUsedAt: true,
        scopes: true,
        runtimeEnvironment: { include: environmentInclude(branchName) },
      },
    });

    if (!match || match.runtimeEnvironment.project.deletedAt !== null) {
      return { ok: false, status: 401, error: "Invalid API key", resolution };
    }

    const [branchError, resolvedEnvironment] = resolveBranch(
      match.runtimeEnvironment,
      branchName,
      allowPreviewParent
    );
    if (branchError !== null) {
      return {
        ok: false,
        status: 401,
        error: branchError,
        resolution,
      };
    }

    if (!match.lastUsedAt || match.lastUsedAt < new Date(now.getTime() - 300_000)) {
      try {
        await this.prisma.apiKey.updateMany({
          where: {
            id: match.id,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          data: { lastUsedAt: now },
        });
      } catch {
        // Authentication should not fail because last-used telemetry could not be recorded.
      }
    }

    return {
      ok: true,
      environment: toAuthenticatedEnvironment(resolvedEnvironment),
      subject: {
        type: "apiKey",
        apiKeyId: match.id,
        restricted: !scopesGrantFullAccess(match.scopes),
        organizationId: resolvedEnvironment.organizationId,
        projectId: resolvedEnvironment.projectId,
      },
      ability: buildJwtAbility(match.scopes),
      resolution,
    };
  }
}

function environmentInclude(branchName: string | null) {
  return {
    project: true,
    organization: true,
    orgMember: {
      select: {
        userId: true,
        user: { select: { id: true, displayName: true, name: true } },
      },
    },
    parentEnvironment: { select: { id: true, apiKey: true } },
    childEnvironments: branchName ? { where: { branchName, archivedAt: null } } : undefined,
  } as const satisfies Prisma.RuntimeEnvironmentInclude;
}

type EnvironmentWithBranches = Prisma.RuntimeEnvironmentGetPayload<{
  include: ReturnType<typeof environmentInclude>;
}>;

type BranchResolution =
  | [error: string, environment: null]
  | [error: null, environment: AuthenticatedEnvironment];

function resolveBranch(
  environment: EnvironmentWithBranches,
  branchName: string | null,
  allowPreviewParent: boolean
): BranchResolution {
  if (environment.type === "PREVIEW" && !branchName && !allowPreviewParent) {
    return ["x-trigger-branch header required for preview env", null];
  }

  if (environment.type === "PREVIEW" || environment.type === "DEVELOPMENT") {
    // The "default" root branch is DEVELOPMENT-only: it maps to the dev root env
    // (which carries no branch), so we skip the pivot there. For PREVIEW,
    // "default" is an ordinary branch name and must still pivot to its child.
    const isDevAndDefault = environment.type === "DEVELOPMENT" && isDefaultDevBranch(branchName);
    if (branchName !== null && !isDevAndDefault) {
      const child = environment.childEnvironments[0];
      if (!child) {
        return ["No matching branch env", null];
      }

      return [
        null,
        {
          ...child,
          apiKey: environment.apiKey,
          orgMember: environment.orgMember,
          organization: environment.organization,
          project: environment.project,
          parentEnvironment: { id: environment.id, apiKey: environment.apiKey },
        },
      ];
    }
  }

  return [null, environment];
}

// Coerce Prisma's Decimal value to a number at the authentication boundary.
function toAuthenticatedEnvironment(
  environment: AuthenticatedEnvironment
): AuthenticatedEnvironment {
  const burst = environment.concurrencyLimitBurstFactor;
  return {
    ...environment,
    concurrencyLimitBurstFactor: typeof burst === "number" ? burst : burst.toNumber(),
  };
}
