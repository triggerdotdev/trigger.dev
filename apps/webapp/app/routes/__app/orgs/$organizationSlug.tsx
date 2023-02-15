import type { LoaderArgs } from "@remix-run/server-runtime";
import invariant from "tiny-invariant";
import { requireUserId } from "~/services/session.server";
import { Outlet } from "@remix-run/react";
import { getOrganizationFromSlug } from "~/models/organization.server";
import { typedjson } from "remix-typedjson";
import { getRuntimeEnvironmentFromRequest } from "~/models/runtimeEnvironment.server";
import {
  commitCurrentOrgSession,
  setCurrentOrg,
} from "~/services/currentOrganization.server";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");

  const organization = await getOrganizationFromSlug({
    userId,
    slug: organizationSlug,
  });

  if (organization === null) {
    throw new Response("Not Found", { status: 404 });
  }

  const currentEnvironmentSlug = await getRuntimeEnvironmentFromRequest(
    request
  );

  const session = await setCurrentOrg(organization.slug, request);

  return typedjson(
    { organization, currentEnvironmentSlug },
    {
      headers: {
        "Set-Cookie": await commitCurrentOrgSession(session),
      },
    }
  );
};

export default function Organization() {
  return (
    <>
      <Outlet />
    </>
  );
}
