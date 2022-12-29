import type { RuntimeEnvironment } from ".prisma/client";
import type { Session } from "@remix-run/node";
import { createCookieSessionStorage } from "@remix-run/node";
import { prisma } from "~/db.server";
import { env } from "~/env.server";

export type { RuntimeEnvironment };

export async function findEnvironmentByApiKey(apiKey: string) {
  const environment = await prisma.runtimeEnvironment.findUnique({
    where: {
      apiKey,
    },
    include: {
      organization: true,
    },
  });

  return environment;
}

export const { commitSession, getSession } = createCookieSessionStorage({
  cookie: {
    name: "__environment",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
  },
});

export async function getRuntimeEnvironmentFromRequest(
  request: Request
): Promise<string> {
  const environmentSession = await getSession(request.headers.get("cookie"));
  return environmentSession.get("environment") ?? "development";
}

export async function getRuntimeEnvironment({
  organizationId,
  slug,
}: {
  organizationId: string;
  slug: string;
}) {
  return prisma.runtimeEnvironment.findUnique({
    where: {
      organizationId_slug: {
        organizationId,
        slug,
      },
    },
  });
}
