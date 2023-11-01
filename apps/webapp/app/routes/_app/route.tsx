import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { useIsOrgChildPage } from "~/hooks/useIsOrgChildPage";
import { clearRedirectTo, commitSession } from "~/services/redirectTo.server";
import { requireUser } from "~/services/session.server";
import { confirmBasicDetailsPath } from "~/utils/pathBuilder";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  //you have to confirm basic details before you can do anything
  if (!user.confirmedBasicDetails) {
    return redirect(confirmBasicDetailsPath());
  }

  return typedjson({
    headers: [["Set-Cookie", await commitSession(await clearRedirectTo(request))]],
  });
};

export default function App() {
  const isOrgChildPage = useIsOrgChildPage();
  const showBackgroundGradient = !isOrgChildPage;

  return (
    <AppContainer showBackgroundGradient={showBackgroundGradient}>
      <Outlet />
    </AppContainer>
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
