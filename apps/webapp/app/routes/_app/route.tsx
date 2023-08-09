import { Outlet, ShouldRevalidateFunction } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { ImpersonationBanner } from "~/components/ImpersonationBanner";
import { NoMobileOverlay } from "~/components/NoMobileOverlay";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { NavBar } from "~/components/navigation/NavBar";
import { useIsProjectChildPage } from "~/hooks/useIsProjectChildPage";
import { getOrganizations } from "~/models/organization.server";
import { getImpersonationId } from "~/services/impersonation.server";
import { clearRedirectTo, commitSession } from "~/services/redirectTo.server";
import { requireUser } from "~/services/session.server";
import { confirmBasicDetailsPath } from "~/utils/pathBuilder";

export const loader = async ({ request }: LoaderArgs) => {
  const user = await requireUser(request);
  const organizations = await getOrganizations({ userId: user.id });
  const impersonationId = await getImpersonationId(request);

  //you have to confirm basic details before you can do anything
  if (!user.confirmedBasicDetails) {
    return redirect(confirmBasicDetailsPath());
  }

  return typedjson(
    {
      organizations,
      impersonationId,
    },
    {
      headers: [["Set-Cookie", await commitSession(await clearRedirectTo(request))]],
    }
  );
};

export const shouldRevalidate: ShouldRevalidateFunction = (options) => {
  //added an org
  if (options.formAction === "/orgs/new") return true;

  //added a project
  if (options.formAction && /^\/orgs\/[^\/]+\/projects\/new$/i.test(options.formAction)) {
    return true;
  }

  //left a team
  if (options.formAction && /^\/orgs\/[^\/]+\/team$/i.test(options.formAction)) {
    return true;
  }

  return false;
};

export default function App() {
  const { impersonationId } = useTypedLoaderData<typeof loader>();
  const isProjectChildPage = useIsProjectChildPage();

  const showBackgroundGradient = !isProjectChildPage;

  return (
    <>
      {impersonationId && <ImpersonationBanner impersonationId={impersonationId} />}
      <NoMobileOverlay />
      <AppContainer showBackgroundGradient={showBackgroundGradient}>
        <NavBar />
        <Outlet />
      </AppContainer>
    </>
  );
}

export function ErrorBoundary() {
  return (
    <>
      <NoMobileOverlay />
      <AppContainer showBackgroundGradient={true}>
        <MainCenteredContainer>
          <RouteErrorDisplay />
        </MainCenteredContainer>
      </AppContainer>
    </>
  );
}
