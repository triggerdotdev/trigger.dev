import type { ShouldRevalidateFunction } from "@remix-run/react";
import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ImpersonationBanner } from "~/components/ImpersonationBanner";
import { NoMobileOverlay } from "~/components/NoMobileOverlay";
import { getOrganizations } from "~/models/organization.server";

import { getImpersonationId } from "~/services/impersonation.server";
import { clearRedirectTo, commitSession } from "~/services/redirectTo.server";
import { requireUserId } from "~/services/session.server";

export const loader = async ({ request }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const organizations = await getOrganizations({ userId });
  const impersonationId = await getImpersonationId(request);

  return typedjson(
    {
      organizations,
      impersonationId,
    },
    {
      headers: [
        ["Set-Cookie", await commitSession(await clearRedirectTo(request))],
      ],
    }
  );
};

export const shouldRevalidate: ShouldRevalidateFunction = (options) => {
  return false;
};

export default function App() {
  const { impersonationId } = useTypedLoaderData<typeof loader>();

  if (impersonationId) {
    return (
      <>
        <ImpersonationBanner impersonationId={impersonationId} />
        <NoMobileOverlay />
        <Outlet />
      </>
    );
  }

  return (
    <>
      <NoMobileOverlay />
      <Outlet />
    </>
  );
}

/* <ProductHuntBanner /> */
