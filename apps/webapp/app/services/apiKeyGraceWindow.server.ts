import { $replica } from "~/db.server";

export function presentedBearerToken(request: Request): string | undefined {
  return request.headers
    .get("Authorization")
    ?.replace(/^Bearer /i, "")
    .trim();
}

export async function isApiKeyInGraceWindow(apiKey: string): Promise<boolean> {
  const revokedKey = await $replica.revokedApiKey.findFirst({
    where: { apiKey, expiresAt: { gt: new Date() } },
    select: { id: true },
  });

  return revokedKey !== null;
}
