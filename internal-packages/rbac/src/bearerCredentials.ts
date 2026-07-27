import type { BearerAuthResult, RbacEnvironment, RbacSubject } from "@trigger.dev/plugins";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@trigger.dev/database";
import { extractJWTSub, isPublicJWT, validateJWT } from "@trigger.dev/core/v3/jwt";
import { isDefaultDevBranch, sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import { scopesGrantFullAccess } from "@trigger.dev/plugins";
import { buildJwtAbility, permissiveAbility } from "./ability.js";

export type BearerCredentialClients = {
  // Used for the `lastUsedAt` telemetry write; reads go to the replica.
  primary: PrismaClient;
  replica: PrismaClient;
};

// JWT-signing material. Today this is the environment's root apiKey (or the
// parent's, for branch envs) — which is why rotating a root key needs the
// grace-window retry in `authenticate`. When a dedicated per-environment
// signing secret lands, this is the only credential-resolution seam that needs
// to change.
export function resolveJwtSigningKey(env: {
  apiKey: string;
  parentEnvironment?: { apiKey: string } | null;
}): string {
  return env.parentEnvironment?.apiKey ?? env.apiKey;
}

/**
 * Resolves an incoming bearer token into a `BearerAuthResult`: a public JWT, a
 * root environment API key, a grace-window rotated key, or a host-owned
 * additional API key (the `ApiKey` table).
 *
 * This is deliberately NOT part of the "no-plugin fallback". Additional API
 * keys are owned by the host, not by the optional RBAC plugin, so this
 * resolution is always-on and is composed by *both* the fallback controller
 * and the plugin-backed controller (which delegates host-owned keys here).
 *
 * Public JWTs carry inline scopes, which are compiled into an ability here.
 * Additional API-key credentials carry host-persisted effective scopes, which
 * are compiled into their final ability here without a plugin policy lookup.
 */
export class BearerCredentialResolver {
  private readonly prisma: PrismaClient;
  private readonly replica: PrismaClient;

  constructor(clients: BearerCredentialClients) {
    this.prisma = clients.primary;
    this.replica = clients.replica;
  }

  async authenticate(
    request: Request,
    options?: { allowJWT?: boolean }
  ): Promise<BearerAuthResult> {
    // Deprecated public API keys (`pk_*` minted long before public JWTs
    // landed) are intentionally NOT handled here. That token format hasn't
    // been issued for years; any `pk_*` bearer on an apiBuilder route returns
    // 401. Public access goes through the JWT path (`isPublicJWT`) instead.
    const rawToken = request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim();
    if (!rawToken) return { ok: false, status: 401, error: "Invalid or Missing API key" };

    if (options?.allowJWT && isPublicJWT(rawToken)) {
      const envId = extractJWTSub(rawToken);
      if (!envId) return { ok: false, status: 401, error: "Invalid Public Access Token" };

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
        return { ok: false, status: 401, error: "Invalid Public Access Token" };
      }

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

        for (const candidate of revoked) {
          const retried = await validateJWT(rawToken, candidate.apiKey);
          if (retried.ok) {
            result = retried;
            break;
          }
        }
      }

      if (!result.ok) return { ok: false, status: 401, error: "Public Access Token is invalid" };

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
      };
    }

    // PREVIEW (and DEVELOPMENT) envs are parents — operating "on a branch" means routing
    // to a child env keyed by branchName. The customer authenticates
    // with the parent's apiKey + an `x-trigger-branch` header. Include the
    // matching child env so the pivot below can adopt its identity.
    const branchName = sanitizeBranchName(request.headers.get("x-trigger-branch"));
    const include = {
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
    } as const;
    const now = new Date();
    let additionalApiKey: { id: string; lastUsedAt: Date | null; scopes: string[] } | null = null;
    let env = await this.replica.runtimeEnvironment.findFirst({
      where: { apiKey: rawToken },
      include,
    });

    // Revoked API key grace window — recently rotated keys keep working until
    // their `expiresAt`; without this a customer who rotates an env API key
    // gets immediate 401s on the new auth path.
    if (!env) {
      const revoked = await this.replica.revokedApiKey.findFirst({
        where: {
          apiKey: rawToken,
          expiresAt: { gt: now },
        },
        include: { runtimeEnvironment: { include } },
      });
      env = revoked?.runtimeEnvironment ?? null;
    }

    if (!env) {
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
          runtimeEnvironment: { include },
        },
      });

      additionalApiKey = match
        ? { id: match.id, lastUsedAt: match.lastUsedAt, scopes: match.scopes }
        : null;
      env = match?.runtimeEnvironment ?? null;
    }

    if (!env || env.project.deletedAt !== null) {
      return { ok: false, status: 401, error: "Invalid API key" };
    }

    if (
      additionalApiKey &&
      (!additionalApiKey.lastUsedAt ||
        additionalApiKey.lastUsedAt < new Date(now.getTime() - 300_000))
    ) {
      try {
        await this.prisma.apiKey.updateMany({
          where: {
            id: additionalApiKey.id,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          data: { lastUsedAt: now },
        });
      } catch {
        // Authentication should not fail because last-used telemetry could not be recorded.
      }
    }

    if (env.type === "PREVIEW" && !branchName) {
      return {
        ok: false,
        status: 401,
        error: "x-trigger-branch header required for preview env",
      };
    }

    if (env.type === "PREVIEW" || env.type === "DEVELOPMENT") {
      // The "default" root branch is DEVELOPMENT-only: it maps to the dev root env
      // (which carries no branch), so we skip the pivot there. For PREVIEW,
      // "default" is an ordinary branch name and must still pivot to its child.
      const isDevAndDefault = env.type === "DEVELOPMENT" && isDefaultDevBranch(branchName);
      if (branchName !== null && !isDevAndDefault) {
        const child = env.childEnvironments?.[0];
        if (!child) {
          return { ok: false, status: 401, error: "No matching branch env" };
        }
        // Pivot to the child env: child's id/type/branchName, parent's
        // apiKey/orgMember/organization/project.
        env = {
          ...child,
          apiKey: env.apiKey,
          orgMember: env.orgMember,
          organization: env.organization,
          project: env.project,
          parentEnvironment: { id: env.id, apiKey: env.apiKey },
          childEnvironments: [],
        };
      }
    }

    // An additional (ApiKey-table) key is a first-class `apiKey` principal.
    // Root/legacy environment keys keep the `user` subject (they're on their
    // way out once additional keys fully replace them).
    const subject: RbacSubject = additionalApiKey
      ? {
          type: "apiKey",
          apiKeyId: additionalApiKey.id,
          restricted: !scopesGrantFullAccess(additionalApiKey.scopes),
          organizationId: env.organizationId,
          projectId: env.projectId,
        }
      : {
          type: "user",
          userId: env.orgMember?.userId ?? "",
          organizationId: env.organizationId,
          projectId: env.projectId,
        };

    return {
      ok: true,
      environment: toAuthenticatedEnvironment(env),
      subject,
      ability: additionalApiKey ? buildJwtAbility(additionalApiKey.scopes) : permissiveAbility,
    };
  }
}

// Coerce a Prisma RuntimeEnvironment payload (with project/organization/
// orgMember/parentEnvironment includes) into the slim AuthenticatedEnvironment
// the auth contract carries. Explicit coercion keeps
// `concurrencyLimitBurstFactor` a plain number across the auth boundary.
function toAuthenticatedEnvironment(env: RbacEnvironment): RbacEnvironment {
  const burst = env.concurrencyLimitBurstFactor;
  return {
    ...env,
    concurrencyLimitBurstFactor: typeof burst === "number" ? burst : burst.toNumber(),
  };
}
