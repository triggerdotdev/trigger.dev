import { Outlet, ShouldRevalidateFunction } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { ImpersonationBanner } from "~/components/ImpersonationBanner";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { NavBar } from "~/components/navigation/NavBar";
import { useIsOrgChildPage } from "~/hooks/useIsOrgChildPage";
import { getImpersonationId } from "~/services/impersonation.server";
import { clearRedirectTo, commitSession } from "~/services/redirectTo.server";
import { requireUser } from "~/services/session.server";
import { confirmBasicDetailsPath } from "~/utils/pathBuilder";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const impersonationId = await getImpersonationId(request);

  //you have to confirm basic details before you can do anything
  if (!user.confirmedBasicDetails) {
    return redirect(confirmBasicDetailsPath());
  }

  return typedjson(
    {
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
  const isOrgChildPage = useIsOrgChildPage();
  const showBackgroundGradient = !isOrgChildPage;

  return (
    <>
      {impersonationId && <ImpersonationBanner impersonationId={impersonationId} />}
      <AppContainer showBackgroundGradient={showBackgroundGradient}>
        <Outlet />
      </AppContainer>
    </>
  );
}

export function ErrorBoundary() {
  return (
    <>
      <AppContainer showBackgroundGradient={true}>
        <MainCenteredContainer>
          <RouteErrorDisplay />
        </MainCenteredContainer>
      </AppContainer>
    </>
  );
}
