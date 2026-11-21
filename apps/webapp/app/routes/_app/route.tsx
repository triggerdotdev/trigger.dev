import { Outlet, type ShouldRevalidateFunction } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { clearRedirectTo, commitSession } from "~/services/redirectTo.server";
import { requireUser } from "~/services/session.server";
import { tenantContext } from "~/services/tenantContext.server";
import { onlyDetailTabChanged } from "~/utils/detailTabRevalidation";
import { confirmBasicDetailsPath } from "~/utils/pathBuilder";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  tenantContext.enrich({ userId: user.id });

  //you have to confirm basic details before you can do anything
  if (!user.confirmedBasicDetails) {
    return redirect(confirmBasicDetailsPath());
  }

  return typedjson(
    {},
    {
      headers: { "Set-Cookie": await commitSession(await clearRedirectTo(request)) },
    }
  );
};

// A detail page tab switch: this loader doesn't read `?tab=`.
export const shouldRevalidate: ShouldRevalidateFunction = (args) =>
  onlyDetailTabChanged(args) ? false : args.defaultShouldRevalidate;

export default function App() {
  return (
    <AppContainer>
      <Outlet />
    </AppContainer>
  );
}

export function ErrorBoundary() {
  return (
    <AppContainer>
      <MainCenteredContainer>
        <RouteErrorDisplay />
      </MainCenteredContainer>
    </AppContainer>
  );
}
