import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "remix-typedjson";
import { z } from "zod";
import { $replica } from "~/db.server";
import { createGitHubAppInstallSession } from "~/services/gitHubSession.server";
import { requireUser } from "~/services/session.server";
import { newOrganizationPath } from "~/utils/pathBuilder";
import { logger } from "~/services/logger.server";

const QuerySchema = z.object({
  org_slug: z.string(),
  redirect_to: z.string(),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const searchParams = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse(Object.fromEntries(searchParams));

  if (!parsed.success) {
    logger.warn("GitHub App installation redirect with invalid params", {
      searchParams,
      error: parsed.error,
    });
    throw redirect("/");
  }

  const { org_slug, redirect_to } = parsed.data;
  const user = await requireUser(request);

  const org = await $replica.organization.findFirst({
    where: { slug: org_slug, members: { some: { userId: user.id } }, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
    },
  });

  if (!org) {
    throw redirect(newOrganizationPath());
  }

  const { url, cookieHeader } = await createGitHubAppInstallSession(org.id, redirect_to);

  return redirect(url, {
    headers: {
      "Set-Cookie": cookieHeader,
    },
  });
};
