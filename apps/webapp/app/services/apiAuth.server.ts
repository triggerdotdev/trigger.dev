import { Prettify } from "@trigger.dev/core";
import { z } from "zod";
import {
  findEnvironmentByApiKey,
  findEnvironmentByPublicApiKey,
} from "~/models/runtimeEnvironment.server";
import {
  PersonalAccessTokenAuthenticationResult,
  authenticateApiRequestWithPersonalAccessToken,
  isPersonalAccessToken,
} from "./personalAccessToken.server";
import { prisma } from "~/db.server";
import { json } from "@remix-run/server-runtime";
import { findProjectByRef } from "~/models/project.server";
import { SignJWT } from "jose";

type Optional<T, K extends keyof T> = Prettify<Omit<T, K> & Partial<Pick<T, K>>>;

const AuthorizationHeaderSchema = z.string().regex(/^Bearer .+$/);

export type AuthenticatedEnvironment = Optional<
  NonNullable<Awaited<ReturnType<typeof findEnvironmentByApiKey>>>,
  "orgMember"
>;

type ApiAuthenticationResult = {
  apiKey: string;
  type: "PUBLIC" | "PRIVATE";
  environment: AuthenticatedEnvironment;
};

export async function authenticateApiRequest(
  request: Request,
  { allowPublicKey = false }: { allowPublicKey?: boolean } = {}
): Promise<ApiAuthenticationResult | undefined> {
  const apiKey = getApiKeyFromRequest(request);
  if (!apiKey) {
    return;
  }

  return authenticateApiKey(apiKey, { allowPublicKey });
}

export async function authenticateApiKey(
  apiKey: string,
  { allowPublicKey = false }: { allowPublicKey?: boolean } = {}
): Promise<ApiAuthenticationResult | undefined> {
  const result = getApiKeyResult(apiKey);

  if (!result) {
    return;
  }

  //if it's a public API key and we don't allow public keys, return
  if (!allowPublicKey) {
    const environment = await findEnvironmentByApiKey(result.apiKey);
    if (!environment) return;
    return {
      ...result,
      environment,
    };
  }

  switch (result.type) {
    case "PUBLIC": {
      const environment = await findEnvironmentByPublicApiKey(result.apiKey);
      if (!environment) return;
      return {
        ...result,
        environment,
      };
    }
    case "PRIVATE": {
      const environment = await findEnvironmentByApiKey(result.apiKey);
      if (!environment) return;
      return {
        ...result,
        environment,
      };
    }
  }
}

export function isPublicApiKey(key: string) {
  return key.startsWith("pk_");
}

export function getApiKeyFromRequest(request: Request) {
  const rawAuthorization = request.headers.get("Authorization");

  const authorization = AuthorizationHeaderSchema.safeParse(rawAuthorization);
  if (!authorization.success) {
    return;
  }

  const apiKey = authorization.data.replace(/^Bearer /, "");
  return apiKey;
}

export function getApiKeyResult(apiKey: string) {
  const type = isPublicApiKey(apiKey) ? ("PUBLIC" as const) : ("PRIVATE" as const);
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
  const apiKey = getApiKeyFromRequest(request);
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

  const result = await authenticateApiKey(apiKey, { allowPublicKey: false });

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
  slug: string
): Promise<AuthenticatedEnvironment> {
  switch (auth.type) {
    case "apiKey": {
      if (auth.result.environment.project.externalRef !== projectRef) {
        throw json(
          {
            error:
              "Invalid project ref for this API key. Make sure you are using an API key associated with that project.",
          },
          { status: 400 }
        );
      }

      if (auth.result.environment.slug !== slug) {
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
  }
}

export async function generateJWTTokenForEnvironment(environment: AuthenticatedEnvironment) {
  const secret = new TextEncoder().encode(
    "cc7e0d44fd473002f1c42167459001140ec6389b7353f8088f4d9a95f2f596f2"
  );

  const alg = "HS256";

  const jwt = await new SignJWT({ environment_id: environment.id })
    .setProtectedHeader({ alg })
    .setIssuedAt()
    .setIssuer("https://id.trigger.dev")
    .setAudience("https://api.trigger.dev")
    .setExpirationTime("2h")
    .sign(secret);

  return jwt;
}
