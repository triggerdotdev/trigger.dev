import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { clearRedirectTo, commitSession } from "~/services/redirectTo.server";
import { requireUser } from "~/services/session.server";
import { tenantContext } from "~/services/tenantContext.server";
import { confirmBasicDetailsPath } from "~/utils/pathBuilder";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // `requireUser` also enforces `MFA_REQUIRED`: a signed-in user without a
  // second factor is redirected to /mfa/setup before this loader gets any
  // further. That check lives there rather than here so it also covers the
  // routes not nested under this layout (/account/*, /invites, /admin/*) —
  // see services/mfa/mfaRequirement.server.ts.
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
