import { z } from "zod";
import { prisma } from "~/db.server";

const AuthorizationHeaderSchema = z.string().regex(/^Bearer .+$/);

type ApiAuthenticationResult = undefined | string;

export async function authenticateApiRequest(request: Request): Promise<ApiAuthenticationResult> {
  const token = getApiKeyFromRequest(request);

  if (!token) {
    return;
  }
  const isValidKey = await prisma.personalAccessToken.findFirst({
    where: {
      token: token,
    },
  });

  if (isValidKey) {
    await prisma.personalAccessToken.update({
      where: {
        token: token,
      },
      data: {
        lastAccessedAt: new Date(),
      },
    });
    return token;
  }

  return;
}

export function getApiKeyFromRequest(request: Request) {
  const rawAuthorization = request.headers.get("Authorization");

  const authorization = AuthorizationHeaderSchema.safeParse(rawAuthorization);
  if (!authorization.success) {
    return;
  }
  const token = authorization.data.replace(/^Bearer /, "");
  return token;
}
