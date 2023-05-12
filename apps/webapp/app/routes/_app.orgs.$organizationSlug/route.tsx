import type { ShouldRevalidateFunction } from "@remix-run/react";
import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Header1 } from "~/components/primitives/Headers";
import { getOrganizationFromSlug } from "~/models/organization.server";
import { analytics } from "~/services/analytics.server";
import {
  commitCurrentOrgSession,
  setCurrentOrg,
} from "~/services/currentOrganization.server";
import { requireUserId } from "~/services/session.server";

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

  analytics.organization.identify({ organization });

  const session = await setCurrentOrg(organization.slug, request);

  return typedjson(
    {
      organization,
    },
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
      {/* <OrganizationSideMenuCollapsed /> */}
      <Header1>Test</Header1>
      <Outlet />
    </>
  );
}

export const shouldRevalidate: ShouldRevalidateFunction = (options) => {
  if (options.formAction === "/resources/environment") {
    return false;
  }

  return true;
};
