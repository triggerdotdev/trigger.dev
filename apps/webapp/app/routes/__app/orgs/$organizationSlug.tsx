import type { LoaderArgs } from "@remix-run/server-runtime";
import invariant from "tiny-invariant";
import { requireUserId } from "~/services/session.server";
import { Outlet } from "@remix-run/react";
import { getOrganizationFromSlug } from "~/models/organization.server";
import { typedjson } from "remix-typedjson";
import { Header } from "~/components/layout/Header";
import { AppBody } from "~/components/layout/AppLayout";

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

  return typedjson({ organization });
};

export default function Organization() {
  return (
    <>
      <Header />
      <AppBody>
        <Outlet />
      </AppBody>
    </>
  );
}
