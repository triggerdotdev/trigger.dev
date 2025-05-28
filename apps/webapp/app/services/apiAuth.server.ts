import { json } from "@remix-run/server-runtime";
import { type Prettify } from "@trigger.dev/core";
import { SignJWT, errors, jwtVerify } from "jose";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { findProjectByRef } from "~/models/project.server";
import {
  findEnvironmentByApiKey,
  findEnvironmentByPublicApiKey,
} from "~/models/runtimeEnvironment.server";
import { type RuntimeEnvironmentForEnvRepo } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { logger } from "./logger.server";
import {
  type PersonalAccessTokenAuthenticationResult,
  authenticateApiRequestWithPersonalAccessToken,
  isPersonalAccessToken,
} from "./personalAccessToken.server";
import { isPublicJWT, validatePublicJwtKey } from "./realtime/jwtAuth.server";
import { sanitizeBranchName } from "~/v3/gitBranch";

const ClaimsSchema = z.object({
  scopes: z.array(z.string()).optional(),
  // One-time use token
  otu: z.boolean().optional(),
});

type Optional<T, K extends keyof T> = Prettify<Omit<T, K> & Partial<Pick<T, K>>>;

export type AuthenticatedEnvironment = Optional<
  NonNullable<Awaited<ReturnType<typeof findEnvironmentByApiKey>>>,
  "orgMember"
>;

export type ApiAuthenticationResult =
  | ApiAuthenticationResultSuccess
  | ApiAuthenticationResultFailure;

export type ApiAuthenticationResultSuccess = {
  ok: true;
  apiKey: string;
  type: "PUBLIC" | "PRIVATE" | "PUBLIC_JWT";
  environment: AuthenticatedEnvironment;
  scopes?: string[];
  oneTimeUse?: boolean;
};

export type ApiAuthenticationResultFailure = {
  ok: false;
  error: string;
};

/**
 * @deprecated Use `authenticateApiRequestWithFailure` instead.
 */
export async function authenticateApiRequest(
  request: Request,
  options: { allowPublicKey?: boolean; allowJWT?: boolean } = {}
): Promise<ApiAuthenticationResultSuccess | undefined> {
  const { apiKey, branchName } = getApiKeyFromRequest(request);

  if (!apiKey) {
    return;
  }

  const authentication = await authenticateApiKey(apiKey, { ...options, branchName });

  return authentication;
}

/**
 * This method is the same as `authenticateApiRequest` but it returns a failure result instead of undefined.
 * It should be used from now on to ensure that the API key is always validated and provide a failure result.
 */
export async function authenticateApiRequestWithFailure(
  request: Request,
  options: { allowPublicKey?: boolean; allowJWT?: boolean } = {}
): Promise<ApiAuthenticationResult> {
  const { apiKey, branchName } = getApiKeyFromRequest(request);

  if (!apiKey) {
    return {
      ok: false,
      error: "Invalid API Key",
    };
  }

  const authentication = await authenticateApiKeyWithFailure(apiKey, { ...options, branchName });

  return authentication;
}

/**
 * @deprecated Use `authenticateApiKeyWithFailure` instead.
 */
export async function authenticateApiKey(
  apiKey: string,
  options: { allowPublicKey?: boolean; allowJWT?: boolean; branchName?: string } = {}
): Promise<ApiAuthenticationResultSuccess | undefined> {
  const result = getApiKeyResult(apiKey);

  if (!result) {
    return;
  }

  if (!options.allowPublicKey && result.type === "PUBLIC") {
    return;
  }

  if (!options.allowJWT && result.type === "PUBLIC_JWT") {
    return;
  }

  switch (result.type) {
    case "PUBLIC": {
      const environment = await findEnvironmentByPublicApiKey(result.apiKey, options.branchName);
      if (!environment) {
        return;
      }

      return {
        ok: true,
        ...result,
        environment,
      };
    }
    case "PRIVATE": {
      const environment = await findEnvironmentByApiKey(result.apiKey, options.branchName);
      if (!environment) {
        return;
      }

      return {
        ok: true,
        ...result,
        environment,
      };
    }
    case "PUBLIC_JWT": {
      const validationResults = await validatePublicJwtKey(result.apiKey);

      if (!validationResults.ok) {
        return;
      }

      const parsedClaims = ClaimsSchema.safeParse(validationResults.claims);

      return {
        ok: true,
        ...result,
        environment: validationResults.environment,
        scopes: parsedClaims.success ? parsedClaims.data.scopes : [],
        oneTimeUse: parsedClaims.success ? parsedClaims.data.otu : false,
      };
    }
  }
}

/**
 * This method is the same as `authenticateApiKey` but it returns a failure result instead of undefined.
 * It should be used from now on to ensure that the API key is always validated and provide a failure result.
 */
async function authenticateApiKeyWithFailure(
  apiKey: string,
  options: { allowPublicKey?: boolean; allowJWT?: boolean; branchName?: string } = {}
): Promise<ApiAuthenticationResult> {
  const result = getApiKeyResult(apiKey);

  if (!result) {
    return {
      ok: false,
      error: "Invalid API Key",
    };
  }

  if (!options.allowPublicKey && result.type === "PUBLIC") {
    return {
      ok: false,
      error: "Public API keys are not allowed for this request",
    };
  }

  if (!options.allowJWT && result.type === "PUBLIC_JWT") {
    return {
      ok: false,
      error: "Public JWT API keys are not allowed for this request",
    };
  }

  switch (result.type) {
    case "PUBLIC": {
      const environment = await findEnvironmentByPublicApiKey(result.apiKey, options.branchName);
      if (!environment) {
        return {
          ok: false,
          error: "Invalid API Key",
        };
      }

      return {
        ok: true,
        ...result,
        environment,
      };
    }
    case "PRIVATE": {
      const environment = await findEnvironmentByApiKey(result.apiKey, options.branchName);
      if (!environment) {
        return {
          ok: false,
          error: "Invalid API Key",
        };
      }

      return {
        ok: true,
        ...result,
        environment,
      };
    }
    case "PUBLIC_JWT": {
      const validationResults = await validatePublicJwtKey(result.apiKey);

      if (!validationResults.ok) {
        return validationResults;
      }

      const parsedClaims = ClaimsSchema.safeParse(validationResults.claims);

      return {
        ok: true,
        ...result,
        environment: validationResults.environment,
        scopes: parsedClaims.success ? parsedClaims.data.scopes : [],
        oneTimeUse: parsedClaims.success ? parsedClaims.data.otu : false,
      };
    }
  }
}

export async function authenticateAuthorizationHeader(
  authorization: string,
  {
    allowPublicKey = false,
    allowJWT = false,
  }: { allowPublicKey?: boolean; allowJWT?: boolean } = {}
): Promise<ApiAuthenticationResult | undefined> {
  const apiKey = getApiKeyFromHeader(authorization);

  if (!apiKey) {
    return;
  }

  return authenticateApiKey(apiKey, { allowPublicKey, allowJWT });
}

function isPublicApiKey(key: string) {
  return key.startsWith("pk_");
}

function isSecretApiKey(key: string) {
  return key.startsWith("tr_");
}

export function branchNameFromRequest(request: Request): string | undefined {
  return request.headers.get("x-trigger-branch") ?? undefined;
}

function getApiKeyFromRequest(request: Request): {
  apiKey: string | undefined;
  branchName: string | undefined;
} {
  const apiKey = getApiKeyFromHeader(request.headers.get("Authorization"));
  const branchName = branchNameFromRequest(request);

  return { apiKey, branchName };
}

function getApiKeyFromHeader(authorization?: string | null) {
  if (typeof authorization !== "string" || !authorization) {
    return;
  }

  const apiKey = authorization.replace(/^Bearer /, "");
  return apiKey;
}

function getApiKeyResult(apiKey: string): {
  apiKey: string;
  type: "PUBLIC" | "PRIVATE" | "PUBLIC_JWT";
} {
  const type = isPublicApiKey(apiKey)
    ? "PUBLIC"
    : isSecretApiKey(apiKey)
    ? "PRIVATE"
    : isPublicJWT(apiKey)
    ? "PUBLIC_JWT"
    : "PRIVATE"; // Fallback to private key
  return { apiKey, type };
}

export type DualAuthenticationResult =
  | {
      type: "personalAccessToken";
      result: PersonalAccessTokenAuthenticationResult;
    }
  | {
      type: "apiKey";
      result: ApiAuthenticationResult;
    };

export async function authenticateProjectApiKeyOrPersonalAccessToken(
  request: Request
): Promise<DualAuthenticationResult | undefined> {
  const { apiKey, branchName } = getApiKeyFromRequest(request);
  if (!apiKey) {
    return;
  }

  if (isPersonalAccessToken(apiKey)) {
    const result = await authenticateApiRequestWithPersonalAccessToken(request);

    if (!result) {
      return;
    }

    return {
      type: "personalAccessToken",
      result,
    };
  }

  const result = await authenticateApiKey(apiKey, { allowPublicKey: false, branchName });

  if (!result) {
    return;
  }

  return {
    type: "apiKey",
    result,
  };
}

export async function authenticatedEnvironmentForAuthentication(
  auth: DualAuthenticationResult,
  projectRef: string,
  slug: string,
  branch?: string
): Promise<AuthenticatedEnvironment> {
  if (slug === "staging") {
    slug = "stg";
  }

  switch (auth.type) {
    case "apiKey": {
      if (!auth.result.ok) {
        throw json({ error: auth.result.error }, { status: 401 });
      }

      if (auth.result.environment.project.externalRef !== projectRef) {
        throw json(
          {
            error:
              "Invalid project ref for this API key. Make sure you are using an API key associated with that project.",
          },
          { status: 400 }
        );
      }

      if (auth.result.environment.slug !== slug && auth.result.environment.branchName !== branch) {
        throw json(
          {
            error:
              "Invalid environment slug for this API key. Make sure you are using an API key associated with that environment.",
          },
          { status: 400 }
        );
      }

      return auth.result.environment;
    }
    case "personalAccessToken": {
      const user = await prisma.user.findUnique({
        where: {
          id: auth.result.userId,
        },
      });

      if (!user) {
        throw json({ error: "Invalid or Missing API key" }, { status: 401 });
      }

      const project = await findProjectByRef(projectRef, user.id);

      if (!project) {
        throw json({ error: "Project not found" }, { status: 404 });
      }

      if (!branch) {
        const environment = await prisma.runtimeEnvironment.findFirst({
          where: {
            projectId: project.id,
            slug: slug,
          },
          include: {
            project: true,
            organization: true,
          },
        });

        if (!environment) {
          throw json({ error: "Environment not found" }, { status: 404 });
        }

        return environment;
      }

      const environment = await prisma.runtimeEnvironment.findFirst({
        where: {
          projectId: project.id,
          slug: slug,
          branchName: sanitizeBranchName(branch),
          archivedAt: null,
        },
        include: {
          project: true,
          organization: true,
          parentEnvironment: true,
        },
      });

      if (!environment) {
        throw json({ error: "Branch not found" }, { status: 404 });
      }

      if (!environment.parentEnvironment) {
        throw json({ error: "Branch not associated with a preview environment" }, { status: 400 });
      }

      return {
        ...environment,
        apiKey: environment.parentEnvironment.apiKey,
        organization: environment.organization,
        project: environment.project,
      };
    }
  }
}

const JWT_SECRET = new TextEncoder().encode(env.SESSION_SECRET);
const JWT_ALGORITHM = "HS256";
const DEFAULT_JWT_EXPIRATION_IN_MS = 1000 * 60 * 60; // 1 hour

export async function generateJWTTokenForEnvironment(
  environment: RuntimeEnvironmentForEnvRepo,
  payload: Record<string, string>
) {
  const jwt = await new SignJWT({
    environment_id: environment.id,
    org_id: environment.organizationId,
    project_id: environment.projectId,
    ...payload,
  })
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuedAt()
    .setIssuer("https://id.trigger.dev")
    .setAudience("https://api.trigger.dev")
    .setExpirationTime(calculateJWTExpiration())
    .sign(JWT_SECRET);

  return jwt;
}

export async function validateJWTTokenAndRenew<T extends z.ZodTypeAny>(
  request: Request,
  payloadSchema: T
): Promise<{ payload: z.infer<T>; jwt: string } | undefined> {
  try {
    const jwt = request.headers.get("x-trigger-jwt");

    if (!jwt) {
      logger.debug("Missing JWT token in request", {
        headers: Object.fromEntries(request.headers),
      });

      return;
    }

    const { payload: rawPayload } = await jwtVerify(jwt, JWT_SECRET, {
      issuer: "https://id.trigger.dev",
      audience: "https://api.trigger.dev",
    });

    const payload = payloadSchema.safeParse(rawPayload);

    if (!payload.success) {
      logger.error("Failed to validate JWT", { payload: rawPayload, issues: payload.error.issues });

      return;
    }

    const renewedJwt = await renewJWTToken(payload.data);

    return {
      payload: payload.data,
      jwt: renewedJwt,
    };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      // Now we need to try and renew the token using the API key auth
      const authenticatedEnv = await authenticateApiRequest(request);

      if (!authenticatedEnv) {
        logger.error("Failed to renew JWT token, missing or invalid Authorization header", {
          error: error.message,
        });

        return;
      }

      if (!authenticatedEnv.ok) {
        logger.error("Failed to renew JWT token, invalid API key", {
          error: error.message,
        });

        return;
      }

      const payload = payloadSchema.safeParse(error.payload);

      if (!payload.success) {
        logger.error("Failed to parse jwt payload after expired", {
          payload: error.payload,
          issues: payload.error.issues,
        });

        return;
      }

      const renewedJwt = await generateJWTTokenForEnvironment(authenticatedEnv.environment, {
        ...payload.data,
      });

      logger.debug("Renewed JWT token from Authorization header API Key", {
        environment: authenticatedEnv.environment,
        payload: payload.data,
      });

      return {
        payload: payload.data,
        jwt: renewedJwt,
      };
    }

    logger.error("Failed to validate JWT token", { error });
  }
}

async function renewJWTToken(payload: Record<string, string>) {
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuedAt()
    .setIssuer("https://id.trigger.dev")
    .setAudience("https://api.trigger.dev")
    .setExpirationTime(calculateJWTExpiration())
    .sign(JWT_SECRET);

  return jwt;
}

function calculateJWTExpiration() {
  if (env.PROD_USAGE_HEARTBEAT_INTERVAL_MS) {
    return (
      (Date.now() + Math.max(DEFAULT_JWT_EXPIRATION_IN_MS, env.PROD_USAGE_HEARTBEAT_INTERVAL_MS)) /
      1000
    );
  }

  return (Date.now() + DEFAULT_JWT_EXPIRATION_IN_MS) / 1000;
}

export async function getOneTimeUseToken(
  auth: ApiAuthenticationResultSuccess
): Promise<string | undefined> {
  if (auth.type !== "PUBLIC_JWT") {
    return;
  }

  if (!auth.oneTimeUse) {
    return;
  }

  // Hash the API key to make it unique
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth.apiKey));

  return Buffer.from(hash).toString("hex");
}
