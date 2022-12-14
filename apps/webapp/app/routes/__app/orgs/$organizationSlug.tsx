import type { LoaderArgs } from "@remix-run/server-runtime";
import invariant from "tiny-invariant";
import { requireUserId } from "~/services/session.server";
import { Outlet } from "@remix-run/react";
import { getOrganizationFromSlug } from "~/models/organization.server";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
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
  const { organization } = useTypedLoaderData<typeof loader>();

  return (
    <>
      <Header />
      <AppBody>
        <>
          {organization.environments.map((environment) => {
            return (
              <div key={environment.id}>
                {environment.slug}: {environment.apiKey}
              </div>
            );
          })}
        </>
        <Outlet />
      </AppBody>
    </>
  );
}
